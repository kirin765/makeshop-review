import { createHash, randomUUID } from 'crypto';
import postgres from 'postgres';
import { normalizeReviewLineEndings } from './reviewImport';

// Durable, platform-scoped transfer ledger. A remote write requires a persisted claim.
// Confirmed writes deduplicate by full-file occurrence; unknown outcomes stay blocked.


export type ImportedReviewRow = {
  import_key: string;
  product_uid: string;
  writer: string;
  score: number;
  content: string;
  created_date: string | null;
  imported_at: Date;
};

export type NewImport = {
  product_uid: string;
  writer: string;
  score: number;
  content: string;
  created_date: string | null;
  images?: string[];
  sourceId?: string;
  dedup_hash?: string | null;
};

/**
 * 리뷰 내용으로 중복 판정용 해시를 만든다. 같은 상품·작성자·평점·본문(옵션 포함)·작성일이면
 * 같은 해시 → 재전송 시 이미 옮긴 것으로 보고 건너뛴다.
 * 주의: **보내는 값과 똑같이 정제된** 값으로 만들어야 한다(writeReviews가 만드는 원장 행
 * 그대로). 정제 전 원본으로 만들면 재전송 간 값이 어긋나 멱등이 깨진다(cafe24 2464d56 교훈).
 */
type ReviewHashInput = {
  images?: string[];
  sourceId?: string;
  writer: string;
  score: number;
  content: string;
  created_date?: string | null;
};

function rawReviewHash(productUid: string, r: ReviewHashInput): string {
  const parts = [
    String(productUid),
    String(r.writer ?? ''),
    String(r.score ?? ''),
    String(r.content ?? ''),
    String(r.created_date ?? ''),
  ];
  if (r.images?.length) parts.push('images:' + [...r.images].sort().join('\u0001'));
  if (r.sourceId && r.sourceId !== 'occurrence:0') parts.push(r.sourceId);
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** Normalize line endings so Excel exports cannot create a second identity for one review. */
export function reviewHash(productUid: string, r: ReviewHashInput): string {
  return rawReviewHash(productUid, { ...r, content: normalizeReviewLineEndings(String(r.content ?? '')) });
}

/** Recognize hashes written before line-ending normalization without rewriting old ledger rows. */
export function reviewHashAliases(productUid: string, r: ReviewHashInput): string[] {
  const content = normalizeReviewLineEndings(String(r.content ?? ''));
  const variants = new Set([content, content.replaceAll('\n', '\r\n')]);
  return [...new Set([
    rawReviewHash(productUid, r),
    ...[...variants].map((value) => rawReviewHash(productUid, { ...r, content: value })),
  ])];
}

export type ReviewIdentity = {
  legacyHash: string;
  occurrence: number;
  /** Hashes for the source-aware identity, including historical line endings. */
  aliases?: string[];
  /** Hashes for the content-only legacy identity, including historical line endings. */
  legacyAliases?: string[];
};

const TABLE = 'makeshop_review_imported';

// 서버리스 인스턴스마다 풀을 하나만 맺고 재사용한다. 요청마다 연결을 맺고 끊고 DDL을
// 다시 돌리면 요청당 수백 ms씩 낭비돼 대량 이관이 그만큼 느려진다 (cafe24-review b75caf8).
let shared: postgres.Sql | null = null;
let schemaReady = false;
let schemaPromise: Promise<unknown> | null = null;
const CLAIMS = 'makeshop_review_write_attempt';

function db(): postgres.Sql | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!shared) shared = postgres(url, { max: 1, idle_timeout: 20, max_lifetime: 1800, connect_timeout: 5, connection: { statement_timeout: 5000 } });
  return shared;
}

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T | null> {
  const sql = db();
  if (!sql) return null;
  try {
    if (!schemaReady) {
      schemaPromise ??= sql.begin(async (sql) => {
        await sql`select pg_advisory_xact_lock(hashtext(${TABLE}))`;
        await sql`
          create table if not exists ${sql(TABLE)} (
            import_key text primary key,
            shop_uid text not null,
            product_uid text not null,
            writer text not null,
            score int not null,
            content text not null,
            created_date text,
            dedup_hash text,
            imported_at timestamptz not null default now()
          )`;
        await sql`alter table ${sql(TABLE)} add column if not exists image_urls jsonb not null default '[]'::jsonb`;
        await sql`create index if not exists makeshop_review_imported_mall_hash_idx
          on ${sql(TABLE)} (shop_uid, dedup_hash) where dedup_hash is not null`;
        await sql`create table if not exists ${sql(CLAIMS)} (
          shop_id text not null, dedup_hash text not null, attempted_at timestamptz not null default now(),
          primary key (shop_id, dedup_hash))`;
      });
      try { await schemaPromise; schemaReady = true; }
      catch (error) { schemaPromise = null; throw error; }
    }
    return await fn(sql);
  } catch (e) {
    // 연결 계열 오류일 때만 풀을 버려 다음 호출이 새로 맺게 한다. 순수 SQL 오류까지
    // 버리면 다음 호출마다 연결·DDL을 다시 하게 된다. 스키마는 DB에 있으니 한 번
    // 확인됐으면 풀이 바뀌어도 다시 확인할 필요가 없다.
    const msg = ((e as Error).message ?? '').toLowerCase();
    if (shared === sql && /connect|socket|etimedout|econn|terminat|closed|reset|timeout/.test(msg)) {
      shared = null;
    }
    throw e;
  }
}

export async function recordImports(shopUid: string, rows: NewImport[]): Promise<void> {
  if (!rows.length) return;
  {
    // 한 줄이라도 undefined/NaN이 있으면 postgres가 통째로 거부한다(UNDEFINED_VALUE).
    // 값은 전부 안전한 원시형으로 다듬고, 상품번호가 빈 줄은 버린다.
    const safe = rows
      .map(
        (r) =>
          [
            randomUUID(),
            String(shopUid),
            String(r.product_uid ?? '').slice(0, 100),
            String(r.writer ?? '익명').slice(0, 200),
            Math.min(5, Math.max(1, Math.round(Number(r.score) || 5))),
            String(r.content ?? '').slice(0, 10000),
            r.created_date == null ? null : String(r.created_date).slice(0, 40),
            r.dedup_hash == null ? null : String(r.dedup_hash).slice(0, 64),
            JSON.stringify(r.images ?? []),
          ] as [string, string, string, string, number, string, string | null, string | null, string],
      )
      .filter((r) => r[2].length > 0);
    if (safe.length !== rows.length) throw new Error('Invalid ledger row');
    const saved = await withDb(async (sql) => {
      // ⚠️ postgres 3.4.9의 sql(객체배열, ...컬럼) 헬퍼는 값이 전부 정의돼 있어도
      // UNDEFINED_VALUE를 뱉는다(2026-09 실측·godomall 재현). 배열-of-배열로 직접 넣는다.
      await sql`
        insert into ${sql(TABLE)} (import_key, shop_uid, product_uid, writer, score, content, created_date, dedup_hash, image_urls)
        values ${sql(safe as unknown as readonly (string | number)[][])}
        on conflict (import_key) do nothing`;
      return true;
    });
    if (!saved) throw new Error('Review storage is unavailable');
  }
}

/** Occurrence-aware legacy matching; unresolved old imports remain blocked. */
export async function splitByExisting(
  shopId: string, productId: string, hashes: string[],
  identities: ReviewIdentity[] = hashes.map(legacyHash => ({ legacyHash, occurrence: 0 })),
): Promise<{ pendingIndices: number[]; already: number; blocked: number }> {
  const currentAliases = hashes.map((hash, index) => [...new Set([hash, ...(identities[index]?.aliases ?? [])])]);
  const legacyAliases = identities.map((identity) => [...new Set([identity.legacyHash, ...(identity.legacyAliases ?? [])])]);
  const keys = [...new Set([...currentAliases.flat(), ...legacyAliases.flat()])];
  if (!keys.length) return { pendingIndices: [], already: 0, blocked: 0 };
  const result = await withDb(async (sql) => {
    const rows = await sql<{ dedup_hash: string; confirmed: boolean }[]>`
      select dedup_hash, true as confirmed from ${sql(TABLE)}
      where shop_uid = ${shopId} and product_uid = ${productId} and dedup_hash in ${sql(keys)}`;
    const recordedHashes = new Set(rows.map((row) => row.dedup_hash));
    const claims = await sql<{ dedup_hash: string }[]>`
      select dedup_hash from ${sql(CLAIMS)} where shop_id = ${String(shopId)} and dedup_hash in ${sql(keys)}`;
    const blockedHashes = new Set(claims.map(r => r.dedup_hash).filter((hash) => !recordedHashes.has(hash)));
    const counts = new Map<string, number>();
    const unresolved = new Set<string>();
    for (const row of rows) {
      if (row.confirmed) counts.set(row.dedup_hash, (counts.get(row.dedup_hash) ?? 0) + 1);
      else unresolved.add(row.dedup_hash);
    }
    const countAliases = (aliases: string[]) => [...new Set(aliases)].reduce((total, alias) => total + (counts.get(alias) ?? 0), 0);
    let already = 0; let blocked = 0; const pendingIndices: number[] = [];
    hashes.forEach((hash, index) => {
      const identity = identities[index] ?? { legacyHash: hash, occurrence: 0 };
      const exact = countAliases(currentAliases[index]);
      const legacy = countAliases(legacyAliases[index]);
      const currentBlocked = currentAliases[index].some((alias) => blockedHashes.has(alias) || unresolved.has(alias));
      const legacyBlocked = legacyAliases[index].some((alias) => blockedHashes.has(alias) || unresolved.has(alias));
      if ((hash !== identity.legacyHash && exact > 0) || legacy > identity.occurrence) already++;
      else if (currentBlocked || legacyBlocked) blocked++;
      else pendingIndices.push(index);
    });
    return { pendingIndices, already, blocked };
  });
  if (!result) throw new Error('Review storage is unavailable');
  return result;
}

/** Claim before POST; claims survive crashes and never expire automatically. */
export async function claimImports(shopId: string, hashes: string[]): Promise<boolean> {
  if (!hashes.length) return true;
  const collision = new Error('write already claimed');
  try {
    const result = await withDb(sql => sql.begin(async tx => {
      const values = hashes.map(hash => [String(shopId), hash]);
      const claimed = await tx`insert into ${tx(CLAIMS)} (shop_id, dedup_hash)
        values ${tx(values)} on conflict do nothing returning dedup_hash`;
      if (claimed.length !== hashes.length) throw collision;
      return true;
    }));
    if (!result) throw new Error('Review storage is unavailable');
    return true;
  } catch (error) {
    if (error === collision) return false;
    throw error;
  }
}

/** Only a definite non-creation or verified deletion may release a claim. */
export async function releaseClaims(shopId: string, hashes: string[]): Promise<void> {
  if (!hashes.length) return;
  const result = await withDb(async sql => {
    await sql`delete from ${sql(CLAIMS)} where shop_id = ${String(shopId)} and dedup_hash in ${sql(hashes)}`;
    return true;
  });
  if (!result) throw new Error('Review storage is unavailable');
}

/** 이 상점이 옮긴 리뷰 목록. 상품 필터가 있으면 그 상품만. 최신순, 페이지네이션. */
export async function listImports(
  shopUid: string,
  opts: { productNo?: string; page?: number; pageSize?: number } = {},
): Promise<{ rows: ImportedReviewRow[]; total: number } | null> {
  const productNo = opts.productNo;
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const offset = Math.max(0, (opts.page ?? 1) - 1) * pageSize;
  return withDb(async (sql) => {
    const where = productNo
      ? sql`where shop_uid = ${shopUid} and product_uid = ${productNo}`
      : sql`where shop_uid = ${shopUid}`;
    const [rows, total] = await Promise.all([
      sql<ImportedReviewRow[]>`
        select import_key, product_uid, writer, score, content, created_date, imported_at
        from ${sql(TABLE)} ${where}
        order by imported_at desc, import_key desc
        limit ${pageSize} offset ${offset}`,
      sql<{ n: string }[]>`select count(*) as n from ${sql(TABLE)} ${where}`,
    ]);
    return { rows, total: Number(total[0]?.n ?? 0) };
  });
}

/** 원장에서 실제 삭제에 성공한 행만 지운다. */
export async function removeImports(shopUid: string, importKeys: string[]): Promise<void> {
  if (!importKeys.length) return;
  const removed = await withDb(sql => sql.begin(async tx => {
    const rows = await tx<{ dedup_hash: string | null }[]>`delete from ${tx(TABLE)} where shop_uid = ${shopUid} and import_key in ${tx(importKeys)} returning dedup_hash`;
    const hashes = rows.flatMap(row => row.dedup_hash ? [row.dedup_hash] : []);
    if (hashes.length) await tx`delete from ${tx(CLAIMS)} where shop_id = ${String(shopUid)} and dedup_hash in ${tx(hashes)}
      and not exists (select 1 from ${tx(TABLE)} where shop_uid = ${shopUid} and dedup_hash = ${tx(CLAIMS)}.dedup_hash)`;
    return true;
  }));
  if (!removed) throw new Error('Review storage is unavailable');
}

/** 필터에 해당하는 원장 행 키를 최대 limit개 꺼낸다. 전체 삭제 진행용(서버 순회). */
export async function listImportKeys(
  shopUid: string,
  productNo?: string,
  limit = 50,
): Promise<string[] | null> {
  return withDb(async (sql) => {
    const where = productNo
      ? sql`where shop_uid = ${shopUid} and product_uid = ${productNo}`
      : sql`where shop_uid = ${shopUid}`;
    const rows = await sql<{ import_key: string }[]>`
      select import_key from ${sql(TABLE)} ${where} order by imported_at limit ${limit}`;
    return rows.map((r) => r.import_key);
  });
}

/** 전체 삭제용 — 키로 원장 행을 다시 읽는다(삭제 API에 보낼 값이 필요해서). */
export async function getImports(shopUid: string, importKeys: string[]): Promise<ImportedReviewRow[] | null> {
  if (!importKeys.length) return [];
  return withDb(async (sql) => {
    const rows = await sql<ImportedReviewRow[]>`
      select import_key, product_uid, writer, score, content, created_date, imported_at
      from ${sql(TABLE)} where shop_uid = ${shopUid} and import_key in ${sql(importKeys)}`;
    return rows;
  });
}
