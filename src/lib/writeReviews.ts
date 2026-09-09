import { createReview, type MakeshopReview } from '@/lib/makeshop';
import { toDateTime, type ImportedReview } from '@/lib/reviewImport';
import { recordImports, reviewHash, type NewImport } from '@/lib/imports';

// 메이크샵 review/store는 1건/호출이다. 연속 호출 부하를 막기 위해 건마다 잠깐 쉰다
// (기존 /api/reviews와 같은 리듬). 서버리스 60초 안에서 배치 50건 ≈ 15초 수준.
const DELAY_MS = 150;
// 원장 기록을 1건마다 DB에 쓰면 왕복이 많다. 성공분을 10건씩 모아 기록하되,
// 요청이 중간에 죽어도 최근 10건 안에서는 원장이 남는다(카페24판 2464d56의
// "배치 단위 즉시 기록"과 같은 취지 — 마지막에 몰아 기록하면 죽을 때 전부 사라진다).
// ⚠️ 그래서 멱등에는 ≤10건의 플러시 창 예외가 있다: 창 안에서 죽은 성공분은 미기록이라
// 재전송 시 중복 등록될 수 있다. 1건씩 기록하면 창이 없어지지만 DB 왕복이 배치당 50회가 된다.
const LEDGER_FLUSH = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toPayload(productNo: string, r: ImportedReview): MakeshopReview {
  const score = String(Number.isFinite(r.score) && r.score > 0 ? Math.min(5, Math.round(r.score)) : 5);
  return {
    save_type: 'create',
    uid: productNo,
    hname: r.writer || '익명',
    content: r.option ? `${r.content}\n\n[옵션] ${r.option}` : r.content,
    reg_date: toDateTime(r.createdAt) ?? undefined,
    // 코멘트 평점타입은 score_1..5(1~5)가 전부 있다. 별점 노출이 score_1 단독이든 평균이든
    // 같은 값을 넣어야 0점이 평균을 끌어내리지 않는다 (실측: score_1만 넣으면 나머지가 0으로 저장).
    score_1: score, score_2: score, score_3: score, score_4: score, score_5: score,
    display: 'Y',
  };
}

/** 보낸 값과 똑같이 원장에 남긴다 + 멱등 해시. 배치 라우터의 사전 중복 필터와 같은 정제다. */
export function toNewImport(productNo: string, r: ImportedReview): NewImport {
  const content = r.option ? `${r.content}\n\n[옵션] ${r.option}` : r.content;
  const created = toDateTime(r.createdAt);
  return {
    product_uid: productNo,
    writer: r.writer || '익명',
    score: Number.isFinite(r.score) && r.score > 0 ? Math.min(5, Math.round(r.score)) : 5,
    content,
    created_date: created,
    dedup_hash: reviewHash(productNo, { writer: r.writer || '익명', score: r.score, content, created_date: created }),
  };
}

export type WriteOutcome = {
  written: number;
  failed: number;
  failMessage: string[];
};

/**
 * 리뷰를 메이크샵 상품 후기(코멘트 평점타입)로 1건씩 쓴다. 행별로 성공·실패를 응답으로
 * 알려주므로, 성공분을 10건 단위로 즉시 원장에 남긴다 — 요청이 중간에 죽어도(서버리스
 * 시간 초과 등) 이미 성공한 글은 목록·삭제에서 복구된다. 대량 이관의 핵심.
 *
 * dedup_hash는 "보내는 값과 같은 정제"로 만들어 재전송 멱등(중복 차단)의 근거가 된다.
 * 단, 원장은 LEDGER_FLUSH(10건) 단위로 플러시되므로 마지막 창에서 죽은 성공분은 미기록이고
 * 재전송 시 중복이 될 수 있다(≤10건 예외).
 */
export async function writeReviews(
  token: string,
  shopUid: string,
  productNo: string,
  reviews: ImportedReview[],
): Promise<WriteOutcome> {
  let written = 0;
  let failed = 0;
  const failMessage: string[] = [];
  let ledger: NewImport[] = [];

  const flush = async () => {
    if (!ledger.length) return;
    const rows = ledger;
    ledger = [];
    await recordImports(shopUid, rows).catch((e) =>
      console.error('[writeReviews] ledger failed', (e as Error).message),
    );
  };

  for (const r of reviews) {
    try {
      await createReview(token, shopUid, toPayload(productNo, r));
      written += 1;
      ledger.push(toNewImport(productNo, r));
      if (ledger.length >= LEDGER_FLUSH) await flush();
    } catch (e) {
      failed += 1;
      failMessage.push((e as Error).message.slice(0, 120));
    }
    await sleep(DELAY_MS);
  }
  await flush();

  return { written, failed, failMessage };
}
