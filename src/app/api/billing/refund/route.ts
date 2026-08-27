import { NextRequest, NextResponse } from 'next/server';
import { processRefund } from '@/lib/billing';
import { billingShop, PAYMENT_METHODS } from '@/lib/billingAuth';
import type { PaymentMethod } from '@/lib/makeshop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 환불 완료 처리 — 메이크샵 refund 콜백 호출(201) + 만료일을 오늘로 덮어써 즉시 차단.
 *
 * 환불 경로는 파트너사(우리)가 처리한다 (docs/guide/app/refunds: 구매자 → 파트너 직접 요청).
 * 운영: PG 웹훅(MAKESHOP_BILLING_KEY) 또는 파트너 내부 호출. 심사·로컬: 상점 세션.
 *
 * body: { shop_uid?, partner_order_uid?, amount?, payment_method?, refund_reason? }
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const shopUid = await billingShop(req.headers, typeof body.shop_uid === 'string' ? body.shop_uid : undefined);
  if (!shopUid) return NextResponse.json({ error: 'unauthorized billing call' }, { status: 401 });

  const method = String(body.payment_method ?? 'CARD').toUpperCase();
  if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
    return NextResponse.json({ error: `payment_method must be one of ${PAYMENT_METHODS.join(', ')}` }, { status: 400 });
  }
  const amount = body.amount === undefined ? undefined : Number(body.amount);
  if (amount !== undefined && (!Number.isInteger(amount) || amount <= 0)) {
    return NextResponse.json({ error: 'amount must be a positive integer' }, { status: 400 });
  }

  try {
    const r = await processRefund(shopUid, {
      partnerOrderUid: typeof body.partner_order_uid === 'string' ? body.partner_order_uid : undefined,
      amount,
      paymentMethod: method as PaymentMethod,
      refundReason: typeof body.refund_reason === 'string' ? body.refund_reason : undefined,
    });
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 300) }, { status: 502 });
  }
}