import postgres from 'postgres';
import { getInstalledApp, notifyPayment, notifyRefund, CLIENT_ID, type PaymentMethod } from './makeshop';
import { getValidToken } from './token';

/**
 * 유료앱(파트너 결제) 구독·정산 모델.
 *
 * 메이크샵 파트너센터 정책 (docs/guide/app/trial, docs/guide/app/orders-callback-api):
 * - 무료체험은 **기간 기준**이다. 유료 APP 등록 시 무료체험 기간을 1일 이상 설정하고,
 *   클라이언트(파트너)가 결제/환불을 처리하면 콜백 API로 메이크샵에 전달해야 만료일이 갱신된다.
 * - `GET /api/application/{shop_uid}/apps` → installed_at / expired_at : 설치 시 무료체험 만료일이 자동 결정됨
 * - `POST /api/application/{shop_uid}/callback/payment` (성공 201) — 결제 완료 전달
 * - `POST /api/application/{shop_uid}/callback/refund`  (성공 201) — 환불 완료 전달
 * - callback의 `expired_at`(YYYYMMDD)은 결제/환불 관계없이 **앱 설치 만료일로 강제 덮어쓰기**된다.
 * - 무료체험 종료/만료 후 이용 제한은 파트너사(우리)가 자체 처리한다 → quota.ts가 402로 막는다.
 *
 * 결제 방식은 "유료 — 파트너 결제"로, 상점 대금은 우리 결제 시스템(PG)에서 받고
 * 이 모듈이 메이크샵 콜백을 호출한다. 운영에서 PG 웹훅이 `/api/billing/payment`를 호출하면 된다.
 */

/** 파트너센터 판매 정보 관리에서 설정한 무료체험 기간(일). 여기 값과 일치해야 한다. */
export const TRIAL_DAYS = 14;

/** 유료 플랜 기본값 — 파트너센터 판매 정보(가격)와 일치시킨다. */
export const PLAN = {
  name: '리뷰이사 유료 플랜',
  price: 9900, // 원, 1개월
  termDays: 30,
};

export type SubscriptionStatus = 'trial' | 'paid' | 'expired';

export type Subscription = {
  shopUid: string;
  installedAt: string | null; // ISO
  /** 만료일(ISO, KST 23:59:59 기준). 메이크샵이 관리하고 콜백으로 덮어쓴다. */
  expiredAt: string;
  status: SubscriptionStatus;
  /** 메이크샵 설치 정보를 아직 확인하지 못해 폴백으로 연 만료일인지 (로컬/개발) */
  unverified?: boolean;
};

export type BillingRecord = {
  id?: number;
  shop_uid: string;
  kind: 'payment' | 'refund';
  partner_order_uid: string;
  amount: number;
  payment_method: PaymentMethod | string;
  refund_reason?: string | null;
  expired_at: string;
  callback_status?: number | null;
  created_at: string;
};

export class BillingError extends Error {}

// ---------------------------------------------------------------------------
// 날짜 헬퍼 — 메이크샵 만료일은 YYYYMMDD(달력일)이고 한국시간(KST) 기준이다.
// ---------------------------------------------------------------------------

/** KST(UTC+9) 기준 YYYYMMDD. */
export function toYmd(d: Date): string {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}${g('month')}${g('day')}`;
}

/** YYYYMMDD → 그날 KST 23:59:59의 ISO. 만료는 그날 자정까지로 본다. */
export function endOfDayKst(ymd: string): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d, 14, 59, 59)).toISOString(); // 23:59:59 KST = 14:59:59 UTC
}

function parseExpiredAt(v: string | null | undefined): string | null {
  if (!v) return null;
  if (/^\d{8}$/.test(v)) return endOfDayKst(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** 만료일까지 남은 일수(올림, 최소 0). */
export function daysLeft(iso: string): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
}

function genOrderUid(shopUid: string): string {
  return `ms-${shopUid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// 저장소 — DATABASE_URL이 있으면 Postgres, 없으면 메모리(로컬 개발용).
// ---------------------------------------------------------------------------

type SubRow = {
  shop_uid: string;
  installed_at: string | null;
  expired_at: string;
  status: SubscriptionStatus;
  updated_at: string;
};

interface SubStore {
  get(shopUid: string): Promise<SubRow | null>;
  put(row: SubRow): Promise<void>;
}

interface BillingStore {
  add(rec: BillingRecord): Promise<void>;
  list(shopUid: string, limit: number): Promise<BillingRecord[]>;
}

const memSub = new Map<string, SubRow>();
const memBill: BillingRecord[] = [];

const memorySubStore: SubStore = {
  async get(shopUid) {
    return memSub.get(shopUid) ?? null;
  },
  async put(row) {
    memSub.set(row.shop_uid, row);
  },
};

const memoryBillingStore: BillingStore = {
  async add(rec) {
    memBill.push(rec);
  },
  async list(shopUid, limit) {
    return memBill.filter((r) => r.shop_uid === shopUid).slice(-limit).reverse();
  },
};

function pgStores(url: string): { sub: SubStore; bill: BillingStore } {
  const sql = postgres(url, { max: 1 });
  let ready: Promise<void> | null = null;
  // 주의: postgres.js는 하나의 prepared statement에 여러 SQL 문을 넣을 수 없다 (Neon 500/502).
  // 문장별로 나눠 실행해야 한다 (2026-08-31 실측 — 콜백 502의 원인).
  const init = () =>
    (ready ??= (async () => {
      await sql`create table if not exists makeshop_subscription (
        shop_uid text primary key,
        installed_at timestamptz,
        expired_at timestamptz not null,
        status text not null default 'trial',
        updated_at timestamptz not null default now()
      )`;
      await sql`create table if not exists makeshop_billing (
        id bigserial primary key,
        shop_uid text not null,
        kind text not null,
        partner_order_uid text not null,
        amount int not null,
        payment_method text not null,
        refund_reason text,
        expired_at timestamptz not null,
        callback_status int,
        created_at timestamptz not null default now()
      )`;
      await sql`create index if not exists makeshop_billing_shop_idx on makeshop_billing (shop_uid, id desc)`;
    })());

  const row = (r: { installed_at: Date | null; expired_at: Date; status: string; updated_at: Date }): SubRow => ({
    shop_uid: '',
    installed_at: r.installed_at ? r.installed_at.toISOString() : null,
    expired_at: r.expired_at.toISOString(),
    status: r.status as SubscriptionStatus,
    updated_at: r.updated_at.toISOString(),
  });

  return {
    sub: {
      async get(shopUid) {
        await init();
        const [r] = await sql<
          { installed_at: Date | null; expired_at: Date; status: string; updated_at: Date }[]
        >`select installed_at, expired_at, status, updated_at from makeshop_subscription where shop_uid = ${shopUid}`;
        return r ? { ...row(r), shop_uid: shopUid } : null;
      },
      async put(toPut) {
        await init();
        await sql`
          insert into makeshop_subscription (shop_uid, installed_at, expired_at, status, updated_at)
          values (${toPut.shop_uid}, ${toPut.installed_at}, ${toPut.expired_at}, ${toPut.status}, ${toPut.updated_at})
          on conflict (shop_uid) do update set
            installed_at = excluded.installed_at,
            expired_at = excluded.expired_at,
            status = excluded.status,
            updated_at = excluded.updated_at`;
      },
    },
    bill: {
      async add(rec) {
        await init();
        await sql`
          insert into makeshop_billing (shop_uid, kind, partner_order_uid, amount, payment_method, refund_reason, expired_at, callback_status)
          values (${rec.shop_uid}, ${rec.kind}, ${rec.partner_order_uid}, ${rec.amount}, ${rec.payment_method}, ${rec.refund_reason ?? null}, ${rec.expired_at}, ${rec.callback_status ?? null})`;
      },
      async list(shopUid, limit) {
        await init();
        const rows = await sql<
          { id: number; kind: string; partner_order_uid: string; amount: number; payment_method: string; refund_reason: string | null; expired_at: Date; callback_status: number | null; created_at: Date }[]
        >`
          select id, kind, partner_order_uid, amount, payment_method, refund_reason, expired_at, callback_status, created_at
          from makeshop_billing where shop_uid = ${shopUid} order by id desc limit ${limit}`;
        return rows.map((r) => ({
          id: r.id,
          shop_uid: shopUid,
          kind: r.kind as BillingRecord['kind'],
          partner_order_uid: r.partner_order_uid,
          amount: r.amount,
          payment_method: r.payment_method,
          refund_reason: r.refund_reason,
          expired_at: r.expired_at.toISOString(),
          callback_status: r.callback_status,
          created_at: r.created_at.toISOString(),
        }));
      },
    },
  };
}

const stores = process.env.DATABASE_URL
  ? pgStores(process.env.DATABASE_URL)
  : { sub: memorySubStore, bill: memoryBillingStore };

// ---------------------------------------------------------------------------
// 구독 조회 — 로컬 캐시 우선, 메이크샵 설치 정보(apps)로 검증.
// ---------------------------------------------------------------------------

const REFRESH_MS = 60 * 60 * 1000; // 만료 상태는 1시간마다 한 번씩 재확인 (콜백 누락 대비)

function toSubscription(row: SubRow, unverified = false): Subscription {
  let status = row.status;
  if (status !== 'expired' && Date.parse(row.expired_at) <= Date.now()) status = 'expired';
  return {
    shopUid: row.shop_uid,
    installedAt: row.installed_at,
    expiredAt: row.expired_at,
    status,
    unverified,
  };
}

/**
 * 상점의 구독 상태를 돌려준다.
 * - trial/paid 캐시는 신뢰한다 (expired_at은 우리 콜백으로만 바뀐다).
 * - 캐시가 없으면 설치 정보(GET apps)에서 만료일을 읽어 캐시한다.
 * - expired 캐시는 1시간마다 한 번 재확인한다 — 콜백 API가 누락됐어도 회복되게.
 * - 메이크샵 확인이 불가능하면(IP 미등록 등) 무료체험으로 열어주되 `unverified`로 표시한다 (개발/심사 몰).
 */
export async function getSubscription(shopUid: string): Promise<Subscription> {
  const cached = await stores.sub.get(shopUid);
  const now = Date.now();

  const needRefresh =
    !cached ||
    (cached.status === 'expired' && now - Date.parse(cached.updated_at) > REFRESH_MS);

  if (needRefresh) {
    try {
      const token = await getValidToken(shopUid);
      if (token) {
        const app = await getInstalledApp(token.access_token, shopUid);
        const exp = parseExpiredAt(app.expired_at);
        if (exp) {
          const row: SubRow = {
            shop_uid: shopUid,
            installed_at: app.installed_at ? new Date(app.installed_at).toISOString() : cached?.installed_at ?? null,
            expired_at: exp,
            // 캐시가 이미 paid였다면 유지 (콜백 값이 apps보다 정확하다)
            status: cached?.status === 'paid' ? 'paid' : Date.parse(exp) > now ? 'trial' : 'expired',
            updated_at: new Date(now).toISOString(),
          };
          await stores.sub.put(row);
          return toSubscription(row);
        }
      }
    } catch {
      // 조회 실패 → 아래에서 폴백
    }
  }

  if (cached) return toSubscription(cached);

  // 캐시도 없고 조회도 실패 — 무료체험 14일로 열어준다 (unverified)
  const fallback: SubRow = {
    shop_uid: shopUid,
    installed_at: null,
    expired_at: new Date(now + TRIAL_DAYS * 86_400_000).toISOString(),
    status: 'trial',
    updated_at: new Date(now).toISOString(),
  };
  return toSubscription(fallback, true);
}

// ---------------------------------------------------------------------------
// 결제 / 환불 — 로컬 기록 + 메이크샵 콜백 API 호출. 콜백 실패 시 로컬도 기록하지 않는다.
// ---------------------------------------------------------------------------

export type PaymentInput = {
  partnerOrderUid?: string;
  amount?: number;
  paymentMethod: PaymentMethod;
  /** 기본 PLAN.termDays(30일). 이미 유료면 기존 만료일 기준으로 연장된다. */
  termDays?: number;
};

/** 결제 완료 처리 → 메이크샵 payment 콜백(201) → 만료일 갱신. */
export async function processPayment(
  shopUid: string,
  opts: PaymentInput,
): Promise<{ status: 'paid'; expiredAt: string; callbackStatus: number }> {
  const sub = await getSubscription(shopUid);
  // 연장 기준(만료일) — Makeshop이 무기한 센티널로 9999-12-31을 내려줄 수 있다(실측 2026-08-31,
  // hello765). 이걸 그대로 +30일 하면 연도 10000이 되어 YYYYMMDD 검증(8자리)에 걸려 콜백 400이 난다.
  // 현실적 만료일(2500년 이전)만 연장 기준으로 쓰고, 그 외(센티널·과거)는 오늘부터 계산한다.
  const parsedExpiry = Date.parse(sub.expiredAt);
  const usableExpiry =
    Number.isFinite(parsedExpiry) && parsedExpiry > Date.now() && parsedExpiry < Date.UTC(2500, 0, 1)
      ? parsedExpiry
      : Date.now();
  const baseMs = Math.max(Date.now(), usableExpiry);
  const termDays = opts.termDays ?? PLAN.termDays;
  const newExpiry = new Date(baseMs + termDays * 86_400_000);
  const amount = opts.amount ?? PLAN.price;
  const orderUid = opts.partnerOrderUid ?? genOrderUid(shopUid);

  const token = await getValidToken(shopUid);
  if (!token) throw new BillingError('token unavailable (IP allowlist?)');

  const res = await notifyPayment(token.access_token, shopUid, {
    client_id: CLIENT_ID,
    partner_order_uid: orderUid,
    amount,
    payment_method: opts.paymentMethod,
    expired_at: toYmd(newExpiry),
  });

  const row: SubRow = {
    shop_uid: shopUid,
    installed_at: sub.installedAt,
    expired_at: newExpiry.toISOString(),
    status: 'paid',
    updated_at: new Date().toISOString(),
  };
  await stores.sub.put(row);
  await stores.bill.add({
    shop_uid: shopUid,
    kind: 'payment',
    partner_order_uid: orderUid,
    amount,
    payment_method: opts.paymentMethod,
    refund_reason: null,
    expired_at: row.expired_at,
    callback_status: res.status,
    created_at: new Date().toISOString(),
  });
  return { status: 'paid', expiredAt: row.expired_at, callbackStatus: res.status };
}

export type RefundInput = {
  partnerOrderUid?: string;
  amount?: number;
  paymentMethod: PaymentMethod;
  refundReason?: string;
};

/** 환불 완료 처리 → 메이크샵 refund 콜백(201) → 만료일 = 오늘(즉시 만료). */
export async function processRefund(
  shopUid: string,
  opts: RefundInput,
): Promise<{ status: 'expired'; expiredAt: string; callbackStatus: number }> {
  const sub = await getSubscription(shopUid);
  const now = new Date();
  const amount = opts.amount ?? PLAN.price;
  const orderUid = opts.partnerOrderUid ?? genOrderUid(shopUid);

  const token = await getValidToken(shopUid);
  if (!token) throw new BillingError('token unavailable (IP allowlist?)');

  const res = await notifyRefund(token.access_token, shopUid, {
    client_id: CLIENT_ID,
    partner_order_uid: orderUid,
    amount,
    payment_method: opts.paymentMethod,
    refund_reason: opts.refundReason,
    expired_at: toYmd(now),
  });

  const row: SubRow = {
    shop_uid: shopUid,
    installed_at: sub.installedAt,
    expired_at: now.toISOString(),
    status: 'expired',
    updated_at: new Date().toISOString(),
  };
  await stores.sub.put(row);
  await stores.bill.add({
    shop_uid: shopUid,
    kind: 'refund',
    partner_order_uid: orderUid,
    amount,
    payment_method: opts.paymentMethod,
    refund_reason: opts.refundReason ?? null,
    expired_at: row.expired_at,
    callback_status: res.status,
    created_at: new Date().toISOString(),
  });
  return { status: 'expired', expiredAt: row.expired_at, callbackStatus: res.status };
}

/** 결제·환불 이력 (최신순). */
export function getBillingHistory(shopUid: string, limit = 10): Promise<BillingRecord[]> {
  return stores.bill.list(shopUid, limit);
}