import { NextResponse } from 'next/server';
import { sessionShop } from '@/lib/launch';
import { getSubscription, getBillingHistory, daysLeft, PLAN } from '@/lib/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 구독 상태 + 결제/환불 이력 — /admin 상단 카드가 이걸로 렌더한다. */
export async function GET() {
  const shopUid = await sessionShop();
  if (!shopUid) return NextResponse.json({ error: 'no session' }, { status: 401 });

  const sub = await getSubscription(shopUid);
  const history = await getBillingHistory(shopUid, 10);
  return NextResponse.json({
    subscription: {
      status: sub.status,
      installedAt: sub.installedAt,
      expiredAt: sub.expiredAt,
      daysLeft: daysLeft(sub.expiredAt),
      unverified: sub.unverified ?? false,
    },
    plan: PLAN,
    history: history.map((r) => ({
      id: r.id,
      kind: r.kind,
      partnerOrderUid: r.partner_order_uid,
      amount: r.amount,
      paymentMethod: r.payment_method,
      expiredAt: r.expired_at,
      callbackStatus: r.callback_status,
      createdAt: r.created_at,
      refundReason: r.refund_reason,
    })),
  });
}