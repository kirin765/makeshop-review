import { NextRequest, NextResponse } from 'next/server';
import { tokenStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 임시 진단 라우트 (심사 후 제거). 운영에는 노출하지 않는다.
export async function GET(req: NextRequest) {
  const shopUid = req.nextUrl.searchParams.get('shop_uid');
  if (!shopUid) return NextResponse.json({ error: 'shop_uid required' }, { status: 400 });
  const t = await tokenStore.get(shopUid);
  if (!t) return NextResponse.json({ shop_uid: shopUid, hasToken: false });
  return NextResponse.json({
    shop_uid: shopUid,
    hasToken: true,
    expires_at: t.expires_at,
    accessPrefix: t.access_token.slice(0, 8),
  });
}
