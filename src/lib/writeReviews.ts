import { writeClaimedReviews, type WriteOutcome } from './writeClaimedReviews';
import { createReview, type MakeshopReview } from '@/lib/makeshop';
import { toDateTime, type ImportedReview } from '@/lib/reviewImport';
import { recordImports, reviewHash, claimImports, releaseClaims, type NewImport } from '@/lib/imports';

const DELAY_MS = 150;
const BUDGET_MS = 45000;

function toPayload(productNo: string, r: ImportedReview): MakeshopReview {
  const score = String(Number.isFinite(r.score) && r.score > 0 ? Math.min(5, Math.round(r.score)) : 5);
  return {
    save_type: 'create',
    uid: productNo,
    hname: r.writer || '익명',
    content: r.option ? `${r.content}\n\n[옵션] ${r.option}` : r.content,
    date: toDateTime(r.createdAt) ?? undefined,
    // 코멘트 평점타입은 score_1..5(1~5)가 전부 있다. 별점 노출이 score_1 단독이든 평균이든
    // 같은 값을 넣어야 0점이 평균을 끌어내리지 않는다 (실측: score_1만 넣으면 나머지가 0으로 저장).
    score_1: score, score_2: score, score_3: score, score_4: score, score_5: score,
    display: 'Y',
    file_url: r.images[0], file_url_2: r.images[1], file_url_3: r.images[2], file_url_4: r.images[3],
  };
}

export function toNewImport(productNo: string, r: ImportedReview): NewImport {
  const content = r.option ? `${r.content}\n\n[옵션] ${r.option}` : r.content;
  const created = toDateTime(r.createdAt);
  return {
    sourceId: r.sourceId,
    images: r.images,
    product_uid: productNo,
    writer: r.writer || '익명',
    score: Number.isFinite(r.score) && r.score > 0 ? Math.min(5, Math.round(r.score)) : 5,
    content,
    created_date: created,
    dedup_hash: reviewHash(productNo, { images: r.images, sourceId: r.sourceId, writer: r.writer || '익명', score: r.score, content, created_date: created }),
  };
}

export type { WriteOutcome } from './writeClaimedReviews';

export async function writeReviews(token: string, shopUid: string, productNo: string, reviews: ImportedReview[], deadline = Date.now() + BUDGET_MS): Promise<WriteOutcome> {
  const rows = reviews.map(r => toNewImport(productNo, r));
  return writeClaimedReviews({ rows, hashes: rows.map(r => r.dedup_hash!), batchSize: 1, delayMs: DELAY_MS, deadline,
    claim: hashes => claimImports(shopUid, hashes), release: hashes => releaseClaims(shopUid, hashes),
    save: rows => recordImports(shopUid, rows),
    send: async (start, _count, signal) => { await createReview(token, shopUid, toPayload(productNo, reviews[start]), { signal }); return 'complete'; },
  });
}
