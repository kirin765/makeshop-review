import postgres from 'postgres';
import type { Token } from './makeshop';

/**
 * 토큰 캐시. DATABASE_URL이 있으면 Postgres, 없으면 메모리(로컬 개발용).
 * 메모리 구현은 서버리스에서 인스턴스마다 갈리므로 운영에서 쓰면 안 된다.
 *
 * 메이크샵 토큰은 client_credentials로 5분 유효·(shop_uid, IP)당 1분 5회 제한이라
 * 반드시 재사용해야 한다. 리프레시 토큰이 없어 삭제할 대상은 없고, 만료되면 재발급이다.
 */
export interface TokenStore {
  get(shopUid: string): Promise<Token | null>;
  put(token: Token, shopUid: string): Promise<void>;
}

const memory = new Map<string, Token>();

const memoryStore: TokenStore = {
  async get(shopUid) {
    return memory.get(shopUid) ?? null;
  },
  async put(token, shopUid) {
    memory.set(shopUid, token);
  },
};

function pgStore(url: string): TokenStore {
  const sql = postgres(url, { max: 1 });
  let ready: Promise<void> | null = null;
  const init = () =>
    (ready ??= sql`
      create table if not exists makeshop_token (
        shop_uid text primary key,
        access_token text not null,
        expires_at timestamptz not null,
        updated_at timestamptz not null default now()
      )`.then(() => undefined));

  return {
    async get(shopUid) {
      await init();
      const [row] = await sql<
        { access_token: string; expires_at: Date }[]
      >`select access_token, expires_at from makeshop_token where shop_uid = ${shopUid}`;
      if (!row) return null;
      return { access_token: row.access_token, expires_at: row.expires_at.toISOString() };
    },
    async put(token, shopUid) {
      await init();
      await sql`
        insert into makeshop_token (shop_uid, access_token, expires_at)
        values (${shopUid}, ${token.access_token}, ${token.expires_at})
        on conflict (shop_uid) do update set
          access_token = excluded.access_token,
          expires_at = excluded.expires_at,
          updated_at = now()`;
    },
  };
}

export const tokenStore: TokenStore = process.env.DATABASE_URL
  ? pgStore(process.env.DATABASE_URL)
  : memoryStore;
