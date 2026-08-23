import { createHmac, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';

const SESSION_COOKIE = 'mshop_sess';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24시간 — 메이크샵 토큰은 5분 캐시라 세션은 길게 둔다
const SECRET = process.env.MAKESHOP_SESSION_SECRET || process.env.MAKESHOP_CLIENT_SECRET || 'dev-only-secret';

export type Session = { shopUid: string };

/** 세션 = 서명된 쿠키에 shop_uid를 담는다. 토큰 자체는 DB(makeshop_token)에 캐시한다. */
export function issueSession(shopUid: string): string {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ shopUid, exp: expiry })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function sessionCookie(shopUid: string) {
  const value = issueSession(shopUid);
  return { name: SESSION_COOKIE, value, httpOnly: true, sameSite: 'lax' as const, secure: true, maxAge: SESSION_TTL_MS / 1000, path: '/' };
}

/** 세션 쿠키를 검증해 shop_uid를 돌려준다. 어디서도 쿼리의 shop_uid를 믿지 않는다. */
export async function sessionShop(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let data: { shopUid: string; exp: number };
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
  if (!data.shopUid || Number(data.exp) < Date.now()) return null;
  return data.shopUid;
}

/**
 * 메이크샵이 앱을 실행할 때 붙여 보내는 파라미터를 검증한다 (docs/guide/app/install).
 * - signMessage = `{shop_uid}:{timestamp}:{action_type}` (콜론 구분)
 * - hmac = HMAC-SHA256(signMessage, CLIENT_SECRET) → hex
 * - timestamp는 **밀리초**, 현재와 ±5분(300,000ms) 밖이면 replay로 본다
 */
export function verifyLaunch(
  p: URLSearchParams,
): { shopUid: string; actionType: string } | null {
  const shopUid = p.get('shop_uid');
  const timestamp = p.get('timestamp');
  const actionType = p.get('action_type');
  const hmac = p.get('hmac');

  if (!shopUid || !timestamp || !actionType || !hmac) return null;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return null;
  // 밀리초 단위
  if (Math.abs(Date.now() - ts) > 300_000) return null;

  const signMessage = `${shopUid}:${timestamp}:${actionType}`;
  const expected = createHmac('sha256', process.env.MAKESHOP_CLIENT_SECRET || '').update(signMessage).digest('hex');
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { shopUid, actionType };
}
