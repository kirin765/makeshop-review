import { NextRequest, NextResponse } from 'next/server';
import { sessionShop } from '@/lib/launch';
import { getValidToken } from '@/lib/token';
import { listProducts } from '@/lib/makeshop';
import { checkQuota } from '@/lib/quota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 상품 선택 드롭다운용. 세션이 없으면 401. 상품이 많으면 페이지 단위로 돌려준다. */
export async function GET(req: NextRequest) {
  const shopUid = await sessionShop();
  if (!shopUid) return NextResponse.json({ error: 'no session' }, { status: 401 });

  const token = await getValidToken(shopUid);
  if (!token) return NextResponse.json({ error: 'token unavailable (IP allowlist?)' }, { status: 502 });

  const page = Math.max(1, Number(req.nextUrl.searchParams.get('page') || '1') || 1);
  try {
    const data = await listProducts(token.access_token, shopUid, page);
    const quota = await checkQuota(shopUid, 0);
    return NextResponse.json({
      shopUid,
      quota,
      totalCount: data.totalCount,
      products: data.list.map((p) => ({ no: p.uid, name: p.product_name })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 300) }, { status: 502 });
  }
}
