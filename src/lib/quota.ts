import postgres from 'postgres';

// MVP는 무료 배포. 무료 20건 — 소진 후 402. 유료 전환 시 paid 판정을 여기에 얹는다.
export const FREE_LIMIT = 20;

export async function checkQuota(shopUid: string, want: number) {
  const url = process.env.DATABASE_URL;
  const paid = false; // TODO: 유료 전환 시 판정 로직으로 교체
  if (paid) return { allowed: want, paid: true, used: 0 };
  if (!url) return { allowed: want, paid: false, used: 0 };

  const sql = postgres(url, { max: 1 });
  // cafe24·imweb가 같은 Neon DB를 써서 usage_counter(mall_id)와 충돌 — 전용 테이블을 쓴다.
  await sql`create table if not exists makeshop_usage (
    shop_uid text primary key, written int not null default 0, updated_at timestamptz not null default now())`;
  const [row] = await sql<{ written: number }[]>`select written from makeshop_usage where shop_uid = ${shopUid}`;
  const used = row?.written ?? 0;
  await sql.end();
  return { allowed: Math.max(0, FREE_LIMIT - used), paid: false, used };
}

export async function addUsage(shopUid: string, n: number) {
  const url = process.env.DATABASE_URL;
  if (!url || n <= 0) return;
  const sql = postgres(url, { max: 1 });
  await sql`insert into makeshop_usage (shop_uid, written) values (${shopUid}, ${n})
            on conflict (shop_uid) do update set written = makeshop_usage.written + ${n}, updated_at = now()`;
  await sql.end();
}

/** 앱 삭제 시 사용량을 지운다. 재설치하면 무료 한도로 다시 시작한다. */
export async function resetUsage(shopUid: string) {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const sql = postgres(url, { max: 1 });
  await sql`delete from makeshop_usage where shop_uid = ${shopUid}`;
  await sql.end();
}
