import { NextRequest, NextResponse } from 'next/server';
import { sessionShop } from '@/lib/launch';
import { getValidToken } from '@/lib/token';
import { writeReviews, toNewImport } from '@/lib/writeReviews';
import { maskWriter, type ImportedReview } from '@/lib/reviewImport';
import { checkQuota, addUsage, FREE_LIMIT } from '@/lib/quota';
import { splitByExisting, reviewHash } from '@/lib/imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 메이크샵 review/store는 1건/호출 + 건마다 150ms 대기라(약 7건/초) 서버리스 시간 제한을
// 넉넉히 잡는다. Hobby 상한 60초 안에서 최대한 여유를 준다.
export const maxDuration = 60;

// 클라이언트가 한 번에 보내는 리뷰 수 상한. 1건/호출 + 150ms 대기면
// 100건 ≈ 30~40초 수준이라 60초 안에 끝난다 (클라이언트는 50건씩 보낸다).
export const MAX_BATCH = 100;

/**
 * 대량 이관용 배치 쓰기. 클라이언트가 엑셀을 브라우저에서 파싱한 리뷰를
 * MAX_BATCH 이하로 나눠 보내면 메이크샵 상품 후기에 쓰고 원장을 남긴다.
 *
 * 한 요청에 모든 리뷰를 넣지 않는 이유: 1건/호출이라 수천 건이면 서버리스 함수 시간
 * 제한(60초)을 무조건 넘어 중간에 죽고, 죽으면 원장 기록도 안 돼 목록·삭제가 모두
 * 무력화된다 (godomall/cafe24에서 실측된 같은 문제). 배치마다 성공분이 즉시 원장에
 * 남으므로(writeReviews 내부), 실패해도 여기까지 온 글은 목록에서 보인다.
 *
 * 멱등성: 재전송(요청 중단 후 재시도·브라우저 재시작 후 이어가기)이 와도 내용 해시로
 * 이미 옮긴 리뷰는 걸러낸다(already). 메이크샵은 행별 성공을 응답으로 주므로
 * 카페24판과 같은 멱등이 가능하다 — 단 원장 플러시가 10건 단위라 마지막 창(≤10건)에서
 * 죽은 성공분은 미기록이라 재전송 시 중복이 될 수 있다. 중복은 무료 한도를 소모하지 않는다.
 */
export async function POST(req: NextRequest) {
  const shopUid = await sessionShop();
  if (!shopUid) return NextResponse.json({ error: 'no session' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    product_no?: string;
    reviews?: Partial<ImportedReview>[];
  };
  const productNo = String(body.product_no ?? '');
  const raw = Array.isArray(body.reviews) ? body.reviews : [];
  if (!productNo) return NextResponse.json({ error: 'product_no required' }, { status: 400 });
  if (!raw.length) return NextResponse.json({ error: 'reviews required' }, { status: 400 });

  // 클라이언트 파싱 값은 신뢰하지 않고 서버에서 한 번 더 정제·마스킹한다.
  const parsed = raw.slice(0, MAX_BATCH).map((r) => {
    const score = Number(r.score);
    return {
      score: Number.isFinite(score) && score > 0 ? Math.min(5, Math.round(score)) : 5,
      content: String(r.content ?? '').slice(0, 5000),
      writer: maskWriter(String(r.writer ?? '익명')),
      createdAt: r.createdAt ? String(r.createdAt).slice(0, 40) : null,
      option: r.option ? String(r.option).slice(0, 200) : null,
      productName: r.productName ? String(r.productName).slice(0, 200) : null,
    } satisfies ImportedReview;
  });

  // 이미 옮긴 리뷰(재전송)를 먼저 걸러낸다. DB가 없으면 null → 중복 제거 없이 진행.
  // 해시는 writeReviews가 보내는 값과 같은 정제(toNewImport)로 만든다 — 어긋나면 멱등이 깨진다.
  const hashes = parsed.map((r) => reviewHash(productNo, toNewImport(productNo, r)));
  const dedup = await splitByExisting(shopUid, productNo, hashes);
  const pending = dedup
    ? parsed.filter((_, i) => dedup!.pendingHashes.has(hashes[i]))
    : parsed;
  const already = parsed.length - pending.length;

  const quota = await checkQuota(shopUid, pending.length);
  if (pending.length && quota.allowed <= 0) {
    // 무료체험 만료(기간 종료·환불)면 paywall 신호를 실어 402로 막는다.
    return NextResponse.json(
      {
        quotaExhausted: true,
        paywall: quota.paywall,
        used: quota.used,
        expiredAt: quota.expiredAt,
        already,
        error: 'free limit reached',
      },
      { status: 402 },
    );
  }

  const toWrite = pending.slice(0, Math.max(0, quota.allowed));
  const token = await getValidToken(shopUid);
  if (!token) return NextResponse.json({ error: 'token unavailable (IP allowlist?)' }, { status: 502 });

  const { written, failed, failMessage } = await writeReviews(token.access_token, shopUid, productNo, toWrite);
  if (!quota.paid && written) await addUsage(shopUid, written);

  // 무료 한도로 보낸 슬라이스 일부가 아예 시도되지 않은 경우에만 "한도 소진"이다.
  // (일부 실패는 failed로 반환될 뿐 한도와 무관하다.)
  const quotaExhausted = !quota.paid && toWrite.length < pending.length;
  const remaining = quota.paid ? null : Math.max(0, FREE_LIMIT - quota.used - written);
  return NextResponse.json({
    parsed: parsed.length,
    written,
    failed,
    already,
    quotaExhausted,
    paid: quota.paid,
    freeRemaining: remaining,
    failMessage: failMessage.slice(0, 5),
  });
}
