import postgres from 'postgres';

/**
 * 이관 성공 후 선택적으로 묻는 유입 경로. 전부 **자기신고(self-reported)** 기록이며,
 * 결제 원장·사용량과 절대 합산하지 않는다. 자동 귀속이 아니다.
 *
 * 카페24 버전(64d1b13)의 구조를 메이크샵에 맞게 옮겼다. 선택지는 메이크샵 앱 생태계에
 * 맞춘 값이며, 앱스토어 노출·검색과 다른 무료 앱을 구분해 남긴다.
 */
export const SOURCE_VALUES = [
  'makeshop-store-search',
  'other-free-app',
  'blog-community',
  'referral',
  'other',
  'skipped',
] as const;
export type SourceValue = (typeof SOURCE_VALUES)[number];

const SOURCE_SET: ReadonlySet<string> = new Set(SOURCE_VALUES);

export function isSourceValue(value: unknown): value is SourceValue {
  return typeof value === 'string' && SOURCE_SET.has(value);
}

// DATABASE_URL이 없으면 메모리(로컬 개발용). 서버리스 인스턴스마다 갈리므로 운영에서는 쓰지 않는다.
const memory = new Map<string, SourceValue>();

let surveySql: postgres.Sql | null = null;
let surveySchema: Promise<void> | null = null;

function surveyDb(): postgres.Sql | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  surveySql ??= postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  return surveySql;
}

function ensureSurveyTable(sql: postgres.Sql): Promise<void> {
  surveySchema ??= sql`
    create table if not exists makeshop_source_survey (
      shop_uid text primary key,
      source text not null check (source in (
        'makeshop-store-search', 'other-free-app', 'blog-community',
        'referral', 'other', 'skipped'
      )),
      -- 이 표의 모든 행은 자기신고다. 결제 판정의 근거로 쓰지 않는다.
      self_reported boolean not null default true,
      responded_at timestamptz not null default now()
    )`
    .then(() => undefined)
    .catch((error) => {
      surveySchema = null;
      throw error;
    });
  return surveySchema;
}

/** 이미 답했으면 질문을 다시 띄우지 않는다. 조회 실패는 '미응답'으로 보고 흐름을 막지 않는다. */
export async function hasResponded(shopUid: string): Promise<boolean> {
  const sql = surveyDb();
  if (!sql) return memory.has(shopUid);
  try {
    await ensureSurveyTable(sql);
    const [row] = await sql`
      select 1 from makeshop_source_survey
      where shop_uid = ${shopUid} limit 1`;
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * 최초 응답만 저장한다(on conflict do nothing). 건너뛰기도 응답으로 저장한다.
 * DB 오류는 호출부가 처리할 수 있게 throw한다 — 화면은 재선택을 안내하면 되고
 * 이관·결제 흐름은 이 함수와 무관하게 이미 끝난 상태다.
 */
export async function recordSource(shopUid: string, source: SourceValue): Promise<void> {
  if (!isSourceValue(source)) throw new Error('invalid source');
  const sql = surveyDb();
  if (!sql) {
    if (!memory.has(shopUid)) memory.set(shopUid, source);
    return;
  }
  await ensureSurveyTable(sql);
  await sql`
    insert into makeshop_source_survey (shop_uid, source)
    values (${shopUid}, ${source})
    on conflict (shop_uid) do nothing`;
}
