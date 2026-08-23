import { NextRequest, NextResponse } from 'next/server';
import { sessionShop } from '@/lib/launch';
import { getValidToken } from '@/lib/token';
import { createReview } from '@/lib/makeshop';
import { parseReviewFile, toDateTime, type ImportedReview } from '@/lib/reviewImport';
import { checkQuota, addUsage } from '@/lib/quota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PER_REQUEST = 200; // review/store는 1건/호출. 과도한 반복 호출을 막는다
const DELAY_MS = 150; // 연속 호출 부하 방지

function toPayload(productNo: string, r: ImportedReview): {
  save_type: string; uid: string; hname: string; content: string;
  reg_date?: string; score_1: string; score_2: string; score_3: string; score_4: string; score_5: string; display: string;
} {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest) {
  const shopUid = await sessionShop();
  if (!shopUid) return NextResponse.json({ error: 'no session' }, { status: 401 });

  const form = await req.formData();
  const productNo = String(form.get('product_no') || '');
  const file = form.get('file');
  const dryRun = form.get('dry_run') === '1';

  if (!productNo || !file || typeof file === 'string') {
    return NextResponse.json({ error: 'product_no and file required' }, { status: 400 });
  }

  const buf = await (file as File).arrayBuffer();
  const { reviews, headers } = parseReviewFile(buf);
  if (!reviews.length) return NextResponse.json({ error: 'no reviews parsed', headers }, { status: 400 });

  if (dryRun) {
    const sample = reviews.slice(0, 3).map((r) => ({
      writer: r.writer, content: r.content, score: r.score, createdAt: toDateTime(r.createdAt), option: r.option,
    }));
    return NextResponse.json({ dryRun: true, count: reviews.length, sample });
  }

  const quota = await checkQuota(shopUid, reviews.length);
  if (quota.allowed <= 0) {
    return NextResponse.json({ quotaExceeded: true, used: quota.used, error: 'free limit reached' }, { status: 402 });
  }

  const token = await getValidToken(shopUid);
  if (!token) return NextResponse.json({ error: 'token unavailable (IP allowlist?)' }, { status: 502 });

  const toWrite = reviews.slice(0, Math.min(quota.allowed, MAX_PER_REQUEST));
  let written = 0;
  let skipped = 0;
  const failMessage: string[] = [];
  for (const r of toWrite) {
    try {
      await createReview(token.access_token, shopUid, toPayload(productNo, r));
      written += 1;
    } catch (e) {
      skipped += 1;
      failMessage.push((e as Error).message.slice(0, 120));
    }
    await sleep(DELAY_MS);
  }

  if (!quota.paid) await addUsage(shopUid, written);

  const remaining = quota.paid ? null : Math.max(0, 20 - quota.used - written);
  return NextResponse.json({
    parsed: reviews.length,
    written,
    skipped,
    paid: quota.paid,
    freeRemaining: remaining,
    failMessage: failMessage.slice(0, 5),
  });
}
