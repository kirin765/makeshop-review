import { NextRequest, NextResponse } from 'next/server';
import { sessionShop } from '@/lib/launch';
import { hasResponded, isSourceValue, recordSource } from '@/lib/sourceSurvey';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' } as const;

/**
 * 이관 성공 후 1회 묻는 자기신고 유입 경로. 저장 위치는 세션에서 검증한 shop_uid뿐이며,
 * 결제 원장과 분리되어 있고 자동 귀속으로 해석하지 않는다.
 */
export async function GET() {
  const shopUid = await sessionShop();
  if (!shopUid) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  const answered = await hasResponded(shopUid);
  return NextResponse.json({ answered }, { headers: noStore });
}

export async function POST(req: NextRequest) {
  const shopUid = await sessionShop();
  if (!shopUid) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  const raw = await req.text();
  if (raw.length > 256) {
    return NextResponse.json({ error: 'invalid source' }, { status: 400, headers: noStore });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid source' }, { status: 400, headers: noStore });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid source' }, { status: 400, headers: noStore });
  }
  const keys = Object.keys(body as Record<string, unknown>);
  const source = (body as Record<string, unknown>).source;
  if (keys.length !== 1 || keys[0] !== 'source' || !isSourceValue(source)) {
    return NextResponse.json({ error: 'invalid source' }, { status: 400, headers: noStore });
  }
  try {
    await recordSource(shopUid, source);
  } catch {
    return NextResponse.json({ error: 'storage unavailable' }, { status: 503, headers: noStore });
  }
  return new NextResponse(null, { status: 204, headers: noStore });
}
