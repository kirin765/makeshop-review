import { NextResponse } from 'next/server';
import { sessionShop } from '@/lib/launch';
import { getSubscription, getBillingHistory, daysLeft, PLAN } from '@/lib/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 구독 상태 + 결제/환불 이력 — /admin 상단 카드가 이걸로 렌더한다.
 *
 * `demoMode`: MAKESHOP_BILLING_KEY 미설정(심사·로컬 데모). 이때만 앱 안에서
 * 결제/환불 콜백을 직접 호출해 연동을 입증할 수 있다. 운영(PG 웹훅 연동)에서는
 * 상점 세션으로 결제/환불 엔드포인트를 호출할 수 없으므로 UI의 데모 버튼을 감춘다.
 */
export async function GET() {
  const shopUid = await sessionShop();
  if (!shopUid) return NextResponse.json({ error: 'no session' }, { status: 401 });

  const sub = await getSubscription(shopUid);
  const history = await getBillingHistory(shopUid, 10);
  return NextResponse.json({
    demoMode: !process.env.MAKESHOP_BILLING_KEY,
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