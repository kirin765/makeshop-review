import { sessionShop } from '@/lib/launch';
import { getValidToken } from '@/lib/token';
import { NextRequest, NextResponse } from 'next/server';
import { checkQuota, reserveQuota, releaseQuota, FREE_LIMIT } from '@/lib/quota';
import { writeReviews, toNewImport } from '@/lib/writeReviews';
import { normalizeReviews, MAX_BATCH } from '@/lib/transferInput';
import { splitByExisting, reviewHash, reviewHashAliases } from '@/lib/imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const deadline = Date.now() + 45000;
  const shop = await sessionShop();
  if (!shop) return NextResponse.json({ error: 'no session' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) ?? {};
  const productNo = String(body.product_no ?? '').trim();
  if (!productNo || productNo.length > 100) return NextResponse.json({ error: 'product_no required' }, { status: 400 });
  const raw = Array.isArray(body.reviews) ? body.reviews : [];
  if (!raw.length || raw.length > MAX_BATCH) return NextResponse.json({ error: `한 번에 1~${MAX_BATCH}건까지 보낼 수 있습니다.` }, { status: 400 });
  let reviews;
  try { reviews = normalizeReviews(raw); }
  catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
  const token = await getValidToken(shop);
  if (!token) return NextResponse.json({ error: 'token unavailable', retryable: true }, { status: 503 });
  const ledger = reviews.map(r => toNewImport(productNo, r));
  const hashes = ledger.map(row => reviewHash(productNo, row));
  const identities = ledger.map(row => {
    const legacy = { ...row, sourceId: undefined };
    return {
      legacyHash: reviewHash(productNo, legacy),
      occurrence: Number(row.sourceId?.split(':')[1] ?? 0),
      aliases: reviewHashAliases(productNo, row),
      legacyAliases: reviewHashAliases(productNo, legacy),
    };
  });
  let dedup; let quota;
  try {
    [dedup, quota] = await Promise.all([splitByExisting(shop, productNo, hashes, identities), checkQuota(shop, reviews.length)]);
  } catch { return NextResponse.json({ error: '리뷰 저장소에 연결하지 못했습니다.', retryable: true }, { status: 503 }); }
  const pending = dedup.pendingIndices.map(index => reviews[index]);
  let toWrite = pending; let used = quota.used;
  if (!quota.paid && pending.length) {
    const want = Math.min(pending.length, quota.allowed);
    if (want <= 0) return NextResponse.json({ ...quota, already: dedup.already, quotaExhausted: true, error: '무료 이용 한도를 확인해 주세요.' }, { status: 402 });
    let reserved;
    try { reserved = await reserveQuota(shop, want); }
    catch { return NextResponse.json({ error: '사용량을 저장하지 못했습니다.', retryable: true }, { status: 503 }); }
    if (!reserved.ok) return NextResponse.json({ ...quota, used: reserved.used, already: dedup.already, quotaExhausted: true, error: '무료 이용 한도를 확인해 주세요.' }, { status: 402 });
    used = reserved.used; toWrite = pending.slice(0, want);
  }
  const outcome = await writeReviews(token.access_token, shop, productNo, toWrite, deadline);
  const unused = quota.paid ? 0 : toWrite.length - outcome.written - outcome.uncertainCharged;
  if (unused > 0) await releaseQuota(shop, unused);
  return NextResponse.json({
    ...outcome, parsed: reviews.length, already: dedup.already,
    failed: outcome.failed + dedup.blocked, uncertain: outcome.uncertain + dedup.blocked,
    retryableIndices: outcome.retryableIndices.map(index => dedup.pendingIndices[index]),
    paid: quota.paid, quotaExhausted: toWrite.length < pending.length,
    freeRemaining: quota.paid ? null : Math.max(0, FREE_LIMIT - used + unused),
  });
}
