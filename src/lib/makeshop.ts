export const CLIENT_ID = process.env.MAKESHOP_CLIENT_ID || '';
const CLIENT_SECRET = process.env.MAKESHOP_CLIENT_SECRET || '';

/**
 * API 베이스. 메이크샵은 **접근 허용 IP에 등록된 IP에서만** API가 열린다(최대 10개).
 * Vercel 서버리스 egress는 유동 IP라 등록 불가 → 운영은 홈 공인 IP(61.254.69.43, 2026-08-26 LAN 변경)에서
 * egress하는 홈서버 프록시(makeshop-proxy.sajangbu.com)를 경유한다 (고도몰 godo-proxy와 동일 패턴).
 * 로컬 개발도 이 프록시를 경유한다. 원본 직접 호출 시 집 공인 IP가 접근 허용 IP에 등록돼 있어야 한다.
 */
export const API_BASE =
  process.env.MAKESHOP_API_BASE || 'https://connect.makeshop.co.kr';

// 프록시 경유 시 x-proxy-token 헤더를 붙인다 (홈서버 프록시의 인증 토큰).
const PROXY_TOKEN = process.env.MAKESHOP_PROXY_TOKEN || '';

/**
 * 메이크샵 API 클라이언트.
 *
 * 다른 쇼핑몰 플랫폼(카페24·고도몰·아임웹)과 인증이 근본적으로 다르다:
 * - OAuth 사용자 동의가 없다. 앱 설치 시 APP URL이 shop_uid/timestamp/action_type/hmac을 GET으로 보내오고,
 *   hmac 검증이 곧 인증이다 (docs/guide/app/install).
 * - API 토큰은 client_credentials 방식. shop_uid 단위로 발급되며 **5분 유효**,
 *   **(shop_uid, IP) 조합당 1분에 5회** 제한 (docs/guide/app/access-token).
 *   리프레시 토큰이 없다 — 만료되면 재발급받는다. 5회/분 제한 때문에 반드시 캐시해야 한다.
 * - 개발정보 관리의 "접근 허용 IP"에 등록된 IP에서만 API가 열린다 (IP allowlist).
 */

export type Token = {
  access_token: string;
  /** ISO — 발급 시각 + expires_in. 서버리스라 DB에 캐시해서 5분 안에 재사용한다. */
  expires_at: string;
};

/** 프록시 경유 시 x-proxy-token을 실어 보내는 fetch 래퍼. */
async function proxyFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (PROXY_TOKEN) headers['x-proxy-token'] = PROXY_TOKEN;
  if (init.headers) {
    for (const [k, v] of new Headers(init.headers).entries()) headers[k] = v;
  }
  return fetch(url, { ...init, headers });
}

/** client_credentials 토큰 발급. 5분 유효·1분 5회 제한이라 캐시 우선으로 불러야 한다. */
export async function issueToken(shopUid: string): Promise<Token> {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await proxyFetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', shop_uid: shopUid }),
  });
  if (!res.ok) throw new Error(`makeshop token ${res.status}: ${await res.text()}`);
  const d = await res.json();
  const data = d.data ?? d;
  if (!data?.access_token) throw new Error(`makeshop token missing access_token: ${JSON.stringify(d).slice(0, 200)}`);
  return { access_token: data.access_token, expires_at: new Date(Date.now() + Number(data.expires_in ?? 300) * 1000).toISOString() };
}

/** 모든 상점 API에 공통으로 붙는 헤더. 메이크샵 응답 래퍼는 { return_code, ... } 꼴이다. */
export function apiHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
}

function merged(token: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...apiHeaders(token), ...extra };
  if (PROXY_TOKEN) h['x-proxy-token'] = PROXY_TOKEN;
  return h;
}

/** 응답 래퍼를 풀고 return_code(성공 0000)가 아니면 에러를 던진다. */
export function unwrap<T extends { return_code?: string }>(path: string, d: T): T {
  if (d.return_code !== undefined && d.return_code !== '0000') {
    throw new Error(`makeshop ${path} error return_code=${d.return_code}`);
  }
  return d;
}

/** 설치된 앱 정보 조회 — 설치 확인 + 만료일. Bearer는 shop_uid의 토큰을 쓴다. */
export async function getInstalledApp(token: string, shopUid: string) {
  const q = new URLSearchParams({ client_id: CLIENT_ID });
  const res = await proxyFetch(`${API_BASE}/api/application/${shopUid}/apps?${q}`, { headers: merged(token) });
  if (!res.ok) throw new Error(`installed app ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return (d.data ?? d) as { shop_uid: string; installed_at?: string; expired_at?: string };
}

export type ShopProduct = { uid: string; product_name: string };

/** 상품 목록 조회. fields로 uid/product_name만 받아 부하를 줄인다(공식 권장). 페이지당 1000. */
export async function listProducts(token: string, shopUid: string, page = 1, limit = 1000): Promise<{ totalCount: number; list: ShopProduct[] }> {
  const q = new URLSearchParams({ limit: String(limit), page: String(page), fields: 'uid,product_name' });
  const res = await proxyFetch(`${API_BASE}/api/v1/${shopUid}/product?${q}`, { headers: merged(token) });
  if (!res.ok) throw new Error(`product ${res.status}: ${await res.text()}`);
  const d = unwrap('/product', await res.json()) as { totalCount?: string; list?: ShopProduct[] };
  return { totalCount: Number(d.totalCount ?? 0), list: d.list ?? [] };
}

export type MakeshopReview = {
  save_type: string;
  uid: string; // 상품번호
  hname: string; // 작성자
  content: string;
  file_url?: string;
  file_url_2?: string;
  file_url_3?: string;
  file_url_4?: string;
  date?: string; // YYYY-MM-DD HH:mm:ss (review/store request field)
  score_1?: string; // 1~5
  score_2?: string; // 1~5 (코멘트 평점타입은 5개 항목 전부 저장한다 — 실측: score_1만 넣으면 나머지가 0으로 저장)
  score_3?: string;
  score_4?: string;
  score_5?: string;
  display?: string; // Y
};

/** 코멘트 평점타입 후기 등록 — 1건/호출. 필수: save_type, hname, content. */
export async function createReview(token: string, shopUid: string, review: MakeshopReview, opts: { signal?: AbortSignal } = {}): Promise<void> {
  const res = await proxyFetch(`${API_BASE}/api/v1/${shopUid}/review/store`, {
    method: 'POST',
    headers: merged(token),
    body: JSON.stringify(review),
    signal: opts.signal,
  });
  if (!res.ok) {
    // status를 붙여 던진다 — writeReviews가 400·422(재시도 무의미)를 영구 실패로 분류해
    // 클라이언트의 자동 이어하기가 같은 배치를 무한 재시도하지 않게 한다.
    const err = new Error(`review/store ${res.status}: ${await res.text()}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const d = await res.json();
  const datas = d?.datas ?? {};
  if (datas.result === false) throw Object.assign(new Error('review/store rejected'), { status: 422 });
  if (d?.return_code !== '0000' || ![true, 1, '1'].includes(datas.result)) throw new Error('review/store response was not a confirmed success');
}

/**
 * 코멘트 평점타입 후기 삭제 — POST /api/v1/:shopId/review/delete (개발자센터 게시판 > 후기).
 *
 * ⚠️ 실측 필요: 개발자센터 문서는 요청 본문 스키마를 명시하지 않는다. 등록 문서에
 * "리뷰 수정 시 작성일, 상품번호를 통해 리뷰가 매칭"된다고 명시돼 있어(등록=수정 동일
 * 엔드포인트), 삭제도 같은 키(uid=상품번호·hname=작성자·reg_date=작성일)로 매칭되리라
 * 보고 등록 때 보낸 값 그대로를 보낸다. 응답 형식(200 + return_code)은 등록과 같다고 본다.
 */
export type ReviewDeleteTarget = {
  uid: string; // 상품번호
  hname: string; // 작성자
  reg_date?: string; // 작성일
  content?: string;
};

export async function deleteReview(token: string, shopUid: string, target: ReviewDeleteTarget): Promise<void> {
  const res = await proxyFetch(`${API_BASE}/api/v1/${shopUid}/review/delete`, {
    method: 'POST',
    headers: merged(token),
    body: JSON.stringify({ save_type: 'delete', ...target }),
  });
  if (!res.ok) {
    const err = new Error(`review/delete ${res.status}: ${await res.text()}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const d = await res.json();
  unwrap('/review/delete', d);
  const datas = d.datas ?? {};
  if (datas.result === false) throw new Error(`review/delete rejected: ${(datas.message ?? []).join(', ')}`);
}

// ---------------------------------------------------------------------------
// 유료앱 결제/환불 콜백 API (docs/guide/app/orders-callback-api)
// 파트너사가 자체 결제/환불을 처리한 뒤 이 API로 메이크샵에 전달해야 상점의
// 앱 결제 내역·만료일이 갱신된다. 성공 시 HTTP 201. 액세스 토큰 필수.
// ---------------------------------------------------------------------------

export type PaymentMethod = 'CARD' | 'TRANSFER' | 'VIRTUAL_ACCOUNT' | 'PHONE' | 'FREE';

export type CallbackPayload = {
  client_id: string;
  partner_order_uid: string;
  amount: number;
  payment_method: PaymentMethod;
  /** YYYYMMDD. 결제/환불 관계없이 앱 설치 만료일로 강제 덮어쓰기된다. */
  expired_at?: string;
  refund_reason?: string;
};

/** 결제 완료 전달 — POST /api/application/{shop_uid}/callback/payment (성공 201). */
export async function notifyPayment(token: string, shopUid: string, body: CallbackPayload): Promise<Response> {
  const res = await proxyFetch(`${API_BASE}/api/application/${shopUid}/callback/payment`, {
    method: 'POST',
    headers: merged(token),
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`callback/payment ${res.status}: ${await res.text()}`);
  return res;
}

/** 환불 완료 전달 — POST /api/application/{shop_uid}/callback/refund (성공 201). */
export async function notifyRefund(token: string, shopUid: string, body: CallbackPayload): Promise<Response> {
  const res = await proxyFetch(`${API_BASE}/api/application/${shopUid}/callback/refund`, {
    method: 'POST',
    headers: merged(token),
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`callback/refund ${res.status}: ${await res.text()}`);
  return res;
}
