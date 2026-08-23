import { issueToken, type Token } from './makeshop';
import { tokenStore } from './store';

// 메이크샵: 토큰 5분 유효. 만료 60초 전에 미리 재발급한다.
const SKEW_MS = 60 * 1000;

/** 저장된 토큰을 꺼내되, 만료가 임박했으면 재발급해서 돌려준다. */
export async function getValidToken(shopUid: string): Promise<Token | null> {
  const t = await tokenStore.get(shopUid);
  if (t && Date.parse(t.expires_at) - Date.now() > SKEW_MS) return t;

  try {
    const next = await issueToken(shopUid);
    await tokenStore.put(next, shopUid);
    return next;
  } catch {
    // 재발급 실패(IP 미등록·rate limit 등)면 낡은 토큰을 돌려주지 않는다.
    return null;
  }
}
