import { NextRequest, NextResponse } from 'next/server';
import { processPayment, PLAN } from '@/lib/billing';
import { billingShop, PAYMENT_METHODS } from '@/lib/billingAuth';
import type { PaymentMethod } from '@/lib/makeshop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 결제 완료 처리 — 결제 기록 저장 + 메이크샵 payment 콜백 호출(201) + 만료일 갱신.
 *
 * 운영: PG(결제대행) 웹훅이 이 엔드포인트를 호출한다 (MAKESHOP_BILLING_KEY 설정 시
 * `x-billing-key` 헤더 필수, 상점은 body.shop_uid). 심사·로컬: 상점 세션으로 호출
 * 가능해 앱 안에서 "결제하기" 데모가 그대로 콜백 연동을 입증한다.
 *
 * body: { shop_uid?, partner_order_uid?, amount?, payment_method?, term_days? }
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const shopUid = await billingShop(req.headers, typeof body.shop_uid === 'string' ? body.shop_uid : undefined);
  if (!shopUid) return NextResponse.json({ error: 'unauthorized billing call' }, { status: 401 });

  const method = String(body.payment_method ?? 'CARD').toUpperCase();
  if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
    return NextResponse.json({ error: `payment_method must be one of ${PAYMENT_METHODS.join(', ')}` }, { status: 400 });
  }
  const termDays = body.term_days === undefined ? undefined : Number(body.term_days);
  if (termDays !== undefined && (!Number.isInteger(termDays) || termDays <= 0)) {
    return NextResponse.json({ error: 'term_days must be a positive integer' }, { status: 400 });
  }
  const amount = body.amount === undefined ? undefined : Number(body.amount);
  if (amount !== undefined && (!Number.isInteger(amount) || amount <= 0)) {
    return NextResponse.json({ error: 'amount must be a positive integer' }, { status: 400 });
  }

  try {
    const r = await processPayment(shopUid, {
      partnerOrderUid: typeof body.partner_order_uid === 'string' ? body.partner_order_uid : undefined,
      amount,
      paymentMethod: method as PaymentMethod,
      termDays,
    });
    return NextResponse.json({ ...r, plan: PLAN.name, price: amount ?? PLAN.price });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 300) }, { status: 502 });
  }
}