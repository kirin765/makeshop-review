import { createHash, randomUUID } from 'crypto';
import postgres from 'postgres';

/**
 * 리뷰이사가 옮긴 리뷰 원장 (메이크샵판).
 * 옮기기 성공 시 **1건씩** 즉시 기록한다 — 메이크샵 review/store는 1건/호출이고 응답으로
 * 성공·실패를 행 단위로 알려주므로(cafe24판 2464d56처럼) 원장이 곧 "무엇을 옮겼는가"의
 * 기준이 된다. 이 기록이 있어야 관리 화면에서 걸러 보고, review/delete로 지울 수 있다.
 *
 * dedup_hash: 같은 리뷰를 다시 보냈을 때(브라우저 재시작·요청 중단 후 재시도 등) 중복
 * 등록을 막기 위한 내용 해시. 메이크샵은 행별 성공을 응답으로 주므로 카페24판과 같은
 * 멱등이 가능하다 — 기록된(플러시된) 해시는 재전송에서 무조건 건너뛴다. 플러시가 10건
 * 단위라 마지막 창(≤10건)에서 죽은 성공분은 미기록이고 재전송 시 중복이 될 수 있다.
 *
 * ⚠️ 테이블 명을 고유하게(`makeshop_review_imported`) 쓴다. 이 DATABASE_URL은 다른
 *    프로젝트와 공유되는 DB라 제네릭한 이름은 다른 앱의 테이블과 충돌할 수 있다
 *    (godomall-review의 `godo_review_imported`와 같은 이유, 2026-09-01 실측).
 */

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
  dedup_hash?: string | null;
};

/**
 * 리뷰 내용으로 중복 판정용 해시를 만든다. 같은 상품·작성자·평점·본문(옵션 포함)·작성일이면
 * 같은 해시 → 재전송 시 이미 옮긴 것으로 보고 건너뛴다.
 * 주의: **보내는 값과 똑같이 정제된** 값으로 만들어야 한다(writeReviews가 만드는 원장 행
 * 그대로). 정제 전 원본으로 만들면 재전송 간 값이 어긋나 멱등이 깨진다(cafe24 2464d56 교훈).
 */
export function reviewHash(
  productUid: string,
  r: { writer: string; score: number; content: string; created_date?: string | null },
): string {
  const parts = [
    String(productUid),
    String(r.writer ?? ''),
    String(r.score ?? ''),
    String(r.content ?? ''),
    String(r.created_date ?? ''),
  ];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

const TABLE = 'makeshop_review_imported';

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = postgres(url, { max: 1 });
  try {
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
    await sql`create index if not exists makeshop_review_imported_mall_hash_idx
      on ${sql(TABLE)} (shop_uid, dedup_hash) where dedup_hash is not null`;
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** 옮기기에 성공한 리뷰를 원장에 남긴다. 실패해도 옮기기 자체는 성공했으므로 조용히 넘어간다. */
export async function recordImports(shopUid: string, rows: NewImport[]): Promise<void> {
  if (!rows.length) return;
  try {
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
          ] as [string, string, string, string, number, string, string | null, string | null],
      )
      .filter((r) => r[2].length > 0);
    if (!safe.length) return;
    await withDb(async (sql) => {
      // ⚠️ postgres 3.4.9의 sql(객체배열, ...컬럼) 헬퍼는 값이 전부 정의돼 있어도
      // UNDEFINED_VALUE를 뱉는다(2026-09 실측·godomall 재현). 배열-of-배열로 직접 넣는다.
      await sql`
        insert into ${sql(TABLE)} (import_key, shop_uid, product_uid, writer, score, content, created_date, dedup_hash)
        values ${sql(safe as unknown as readonly (string | number)[][])}
        on conflict (import_key) do nothing`;
    });
  } catch (e) {
    console.error('[imports] record failed', (e as Error).message);
  }
}

/**
 * 이미 옮긴 리뷰(내용 해시 기준)를 가려낸다. 반환: 아직 안 옮긴 pending과
 * 이미 옮긴 건수. DB가 없으면 null → 호출자는 중복 제거 없이 그대로 진행한다.
 */
export async function splitByExisting(
  shopUid: string,
  productUid: string,
  hashes: string[],
): Promise<{ pendingHashes: Set<string>; already: number } | null> {
  const unique = [...new Set(hashes.filter(Boolean))];
  if (!unique.length) return { pendingHashes: new Set(), already: 0 };
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return withDb(async (sql) => {
    const rows = await sql<{ dedup_hash: string }[]>`
      select dedup_hash from ${sql(TABLE)}
      where shop_uid = ${shopUid} and product_uid = ${productUid}
        and dedup_hash in ${sql(unique)} and dedup_hash is not null`;
    const found = new Set(rows.map((r) => r.dedup_hash));
    const pendingHashes = new Set(unique.filter((h) => !found.has(h)));
    return { pendingHashes, already: hashes.filter((h) => h && !pendingHashes.has(h)).length };
  });
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
        order by imported_at desc
        limit ${pageSize} offset ${offset}`,
      sql<{ n: string }[]>`select count(*) as n from ${sql(TABLE)} ${where}`,
    ]);
    return { rows, total: Number(total[0]?.n ?? 0) };
  });
}

/** 원장에서 실제 삭제에 성공한 행만 지운다. */
export async function removeImports(shopUid: string, importKeys: string[]): Promise<void> {
  if (!importKeys.length) return;
  await withDb(async (sql) => {
    await sql`delete from ${sql(TABLE)} where shop_uid = ${shopUid} and import_key in ${sql(importKeys)}`;
  });
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
