import postgres from 'postgres';
import { getSubscription, daysLeft, TRIAL_DAYS, PLAN, type Subscription, type SubscriptionStatus } from './billing';

/**
 * 이용 제한 — 메이크샵 파트너센터 정책에 맞춘 **기간 기준** 무료체험으로 전환.
 *
 * - 무료체험: 파트너센터에서 설정한 기간(14일)까지. 귀사(우리) 정책인 무료 20건 카운터를 체험 기간 안에서 유지한다.
 * - 만료(무료체험 종료·환불): 402 + paywall. 이용 제한은 파트너사(우리) 책임 (docs/guide/app/trial).
 * - 유료: 횟수 제한 없음. 만료일은 결제 콜백으로 갱신된다.
 */
export const FREE_LIMIT = 20;

export type Quota = {
  allowed: number;
  paid: boolean;
  used: number;
  status: SubscriptionStatus;
  expiredAt: string;
  /** 만료 상태에서 402와 함께 UI에 결제 안내를 띄우라는 신호 */
  paywall: boolean;
  daysLeft: number;
  trialDays: number;
  plan: { name: string; price: number; termDays: number };
};

export async function checkQuota(shopUid: string, want: number): Promise<Quota> {
  const sub: Subscription = await getSubscription(shopUid);
  const url = process.env.DATABASE_URL;
  const used = url ? await readUsage(shopUid) : 0;

  const base: Quota = {
    allowed: 0,
    paid: false,
    used,
    status: sub.status,
    expiredAt: sub.expiredAt,
    paywall: false,
    daysLeft: daysLeft(sub.expiredAt),
    trialDays: planDays(sub),
    plan: { name: PLAN.name, price: PLAN.price, termDays: PLAN.termDays },
  };

  if (sub.status === 'expired') {
    // 무료체험 종료 또는 환불 — 결제 전까지 차단
    return { ...base, allowed: 0, paywall: true };
  }
  if (sub.status === 'paid') {
    return { ...base, allowed: want, paid: true };
  }
  // trial — 무료 20건 유지
  if (!url) return { ...base, allowed: want };
  return { ...base, allowed: Math.max(0, FREE_LIMIT - used) };
}

/** trial 상태라면 파트너센터에 설정한 무료체험 기간, 그 외에는 결제 주기. */
function planDays(sub: Subscription): number {
  return sub.status === 'trial' ? TRIAL_DAYS : PLAN.termDays;
}

async function readUsage(shopUid: string): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) return 0;
  const sql = postgres(url, { max: 1 });
  await sql`create table if not exists makeshop_usage (
    shop_uid text primary key, written int not null default 0, updated_at timestamptz not null default now())`;
  const [row] = await sql<{ written: number }[]>`select written from makeshop_usage where shop_uid = ${shopUid}`;
  await sql.end();
  return row?.written ?? 0;
}

export async function addUsage(shopUid: string, n: number) {
  const url = process.env.DATABASE_URL;
  if (!url || n <= 0) return;
  const sql = postgres(url, { max: 1 });
  await sql`insert into makeshop_usage (shop_uid, written) values (${shopUid}, ${n})
            on conflict (shop_uid) do update set written = makeshop_usage.written + ${n}, updated_at = now()`;
  await sql.end();
}

/** 앱 삭제 시 사용량을 지운다. 무료체험 재부여는 메이크샵이 관리한다. */
export async function resetUsage(shopUid: string) {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const sql = postgres(url, { max: 1 });
  await sql`delete from makeshop_usage where shop_uid = ${shopUid}`;
  await sql.end();
}