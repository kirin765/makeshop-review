import { sessionShop } from './launch';

const BILLING_KEY = process.env.MAKESHOP_BILLING_KEY || '';

/**
 * 결제/환불 엔드포인트 인증.
 * - `MAKESHOP_BILLING_KEY` 미설정 (심사·로컬 데모): 상점 세션만으로 호출 가능.
 *   앱 안의 "결제하기"가 바로 이 경로를 호출해 콜백 연동을 입증한다.
 * - 설정됨 (운영): PG 웹훅 전용. `x-billing-key` 헤더가 일치해야 하며,
 *   상점은 body의 `shop_uid`로 받는다. 상점/고객이 임의로 유료화할 수 없다.
 */
export async function billingShop(headers: Headers, bodyShopUid?: string): Promise<string | null> {
  if (BILLING_KEY) {
    return headers.get('x-billing-key') === BILLING_KEY ? bodyShopUid || null : null;
  }
  return sessionShop();
}

export const PAYMENT_METHODS = ['CARD', 'TRANSFER', 'VIRTUAL_ACCOUNT', 'PHONE', 'FREE'] as const;