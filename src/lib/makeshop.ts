const CLIENT_ID = process.env.MAKESHOP_CLIENT_ID || '';
const CLIENT_SECRET = process.env.MAKESHOP_CLIENT_SECRET || '';

/**
 * API 베이스. 메이크샵은 **접근 허용 IP에 등록된 IP에서만** API가 열린다(최대 10개).
 * Vercel 서버리스 egress는 유동 IP라 등록 불가 → 운영은 홈 공인 IP(218.237.176.17)에서
 * egress하는 홈서버 프록시(makeshop-proxy.sajangbu.com)를 경유한다 (고도몰 godo-proxy와 동일 패턴).
 * 로컬 개발은 집 IP가 등록돼 있어 원본을 직접 쓴다.
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
  reg_date?: string; // 0000-00-00 00:00:00
  score_1?: string; // 1~5
  display?: string; // Y
};

/** 코멘트 평점타입 후기 등록 — 1건/호출. 필수: save_type, hname, content. */
export async function createReview(token: string, shopUid: string, review: MakeshopReview): Promise<void> {
  const res = await proxyFetch(`${API_BASE}/api/v1/${shopUid}/review/store`, {
    method: 'POST',
    headers: merged(token),
    body: JSON.stringify(review),
  });
  if (!res.ok) throw new Error(`review/store ${res.status}: ${await res.text()}`);
  const d = await res.json();
  unwrap('/review/store', d);
  const datas = d.datas ?? {};
  if (datas.result === false) throw new Error(`review/store rejected: ${(datas.message ?? []).join(', ')}`);
}
