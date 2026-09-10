import { NextRequest, NextResponse } from 'next/server';
import { sessionShop } from '@/lib/launch';
import { getValidToken } from '@/lib/token';
import { deleteReview } from '@/lib/makeshop';
import {
  listImports,
  removeImports,
  listImportKeys,
  getImports,
  type ImportedReviewRow,
} from '@/lib/imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 삭제는 1건씩 메이크샵을 호출하므로 한 요청당 양을 제한해 Hobby 상한(60초) 안에 끝낸다.
export const maxDuration = 60;

// 한 요청당 삭제할 건 수 상한. 1건/호출 + 건마다 150ms 대기면 30건 ≈ 10~15초 수준.
// 이 값을 넘는 건은 클라이언트가 나눠 보내거나(all=false) 서버가 hasMore로 계속한다(all=true).
const MAX_DELETE = 30;
const DELAY_MS = 150; // 연속 호출 부하 방지 (등록과 같은 리듬)
// 함수 시간 예산 — 예산이 다 살면 반드시 응답한다. 60초 제한을 넘겨 함수가 죽으면
// 클라이언트가 응답을 못 받고 원장 정리(removeImports)도 실행되지 않아 "지웠는데
// 목록엔 남아" 보인다 (cafe24-review 613816f). 못 지운 건은 실패로 돌려 다음 턴에 이어간다.
const BUDGET_MS = 45000;
// 예산이 이만큼 덜 남으면 새 삭제를 시작하지 않는다(호출 1회 + 재시도 여유).
const DELETE_MIN_MS = 5000;

/**
 * 리뷰이사가 옮긴 리뷰 관리. 목록·삭제 모두 원장(makeshop_review_imported)만 기준으로 동작한다.
 * 원장은 옮기기 성공 시 건 단위로 즉시 기록되므로, 새로 옮긴 글은 여기서 보인다.
 *
 * GET    : 이 상점이 옮긴 리뷰 목록 (product_no 필터 + 페이지네이션)
 * DELETE : 원장에 기록된 값을 그대로 review/delete로 보내 실제 삭제하고 원장을 정리한다.
 *          - import_keys로 보내면 최대 MAX_DELETE건만 처리한다.
 *          - all=true로 보내면 해당 필터의 원장을 최대 MAX_DELETE건씩 순회하며 삭제한다.
 *
 * ⚠️ review/delete 요청 스키마는 개발자센터 문서에 명시가 없어(실측 전) 등록 때 보낸
 *    값(상품번호·작성자·작성일)을 그대로 보낸다 — 등록 문서의 "작성일, 상품번호로 매칭" 규칙을 따른다.
 */
export async function GET(req: NextRequest) {
  const shopUid = await sessionShop();
  if (!shopUid) return NextResponse.json({ error: 'no session' }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const productNo = sp.get('product_no') || undefined;
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(sp.get('page_size')) || 50));
  try {
    const pageData = await listImports(shopUid, { productNo, page, pageSize });
    if (!pageData)
      return NextResponse.json(
        { error: '저장소가 연결되지 않았습니다. 잠시 후 다시 시도해 주세요.' },
        { status: 500 },
      );
    return NextResponse.json({
      reviews: pageData.rows,
      total: pageData.total,
      page,
      pageSize,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 300) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const shopUid = await sessionShop();
  if (!shopUid) return NextResponse.json({ error: 'no session' }, { status: 401 });
  const token = await getValidToken(shopUid);
  if (!token) return NextResponse.json({ error: 'token unavailable (IP allowlist?)' }, { status: 502 });

  const body = (await req.json().catch(() => ({}))) as {
    import_keys?: string[];
    all?: boolean;
    product_no?: string;
  };

  let keys: string[] = [];
  let hasMore = false;
  if (body.all) {
    // 전체 삭제: 원장에서 MAX_DELETE+1건을 가져와 초과분이 있으면 계속 이어받게 한다.
    const productNo = body.product_no || undefined;
    const picked = (await listImportKeys(shopUid, productNo, MAX_DELETE + 1)) ?? [];
    hasMore = picked.length > MAX_DELETE;
    keys = picked.slice(0, MAX_DELETE);
  } else {
    keys = [...new Set((body.import_keys ?? []).map(String).filter(Boolean))].slice(0, MAX_DELETE);
  }
  if (!keys.length) return NextResponse.json({ deleted: [], failed: [], hasMore: false });

  // 삭제 API에 보낼 등록 값을 원장에서 읽는다. 원장에 없는 키(이미 정리됨)는 성공으로 본다.
  const rows = (await getImports(shopUid, keys)) ?? [];
  const rowByKey = new Map(rows.map((r) => [r.import_key, r]));

  const deleted: string[] = [];
  const failed: { import_key: string; error: string }[] = [];
  const deadline = Date.now() + BUDGET_MS;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** 한 건을 지운다. 성공·이미 없음이면 ok. 타임아웃·연결 오류는 재시도한다. */
  const deleteOne = async (key: string, row: ImportedReviewRow): Promise<{ ok: boolean; error: string }> => {
    let lastErr = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (Date.now() > deadline) return { ok: false, error: '함수 시간 예산 초과 — 다시 시도해 주세요.' };
      try {
        await deleteReview(token.access_token, shopUid, {
          uid: row.product_uid,
          hname: row.writer,
          reg_date: row.created_date ?? undefined,
          content: row.content,
        });
        return { ok: true, error: '' };
      } catch (e) {
        lastErr = (e as Error).message.slice(0, 200);
        const status = (e as { status?: number }).status;
        // 이미 지워졌거나(404) 데이터가 거부된("rejected") 건은 다시 시도해도 같다.
        if (status === 404 || /rejected/i.test(lastErr)) return { ok: false, error: lastErr };
        if (attempt === 3) break;
        const wait = 500 * (attempt + 1);
        if (Date.now() + wait > deadline - 3000) return { ok: false, error: lastErr };
        await sleep(wait);
      }
    }
    return { ok: false, error: lastErr };
  };

  for (const key of keys) {
    if (deadline - Date.now() <= DELETE_MIN_MS) {
      // 예산 소진 — 남은 건은 실패로 돌려 클라이언트가 이어서 지운다.
      failed.push({ import_key: key, error: '함수 시간 예산 초과 — 다시 시도해 주세요.' });
      continue;
    }
    const row = rowByKey.get(key);
    if (!row) {
      // 이미 원장에서 지워진 행 — 목표가 이뤄진 것이므로 성공 처리한다(멱등).
      deleted.push(key);
      continue;
    }
    const r = await deleteOne(key, row);
    if (r.ok) deleted.push(key);
    else failed.push({ import_key: key, error: r.error });
    await sleep(DELAY_MS);
  }
  try {
    await removeImports(shopUid, deleted);
  } catch (e) {
    console.error('[imports] ledger cleanup failed', (e as Error).message);
  }
  // 전체 삭제에서 아무것도 못 지웠으면 계속 순회하면 같은 글을 다시 시도해 무한 루프가 된다.
  // 이번 턴에서 한 건도 삭제되지 않았다면 중단한다.
  const more = hasMore && deleted.length > 0;
  return NextResponse.json({ deleted, failed, hasMore: more });
}
