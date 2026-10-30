/* eslint-disable @typescript-eslint/no-require-imports -- Local end-to-end harness: disposable database, mock platform API, headless browser. */
/**
 * 메이크샵 리뷰이사 로컬 E2E.
 *
 * 실제 메이크샵·실제 DB·고객 데이터는 쓰지 않는다.
 * - 일회용 PostgreSQL(Docker)을 띄우고 끝나면 삭제한다.
 * - 메이크샵 API는 로컬 mock 서버가 대신한다 (토큰·앱 정보·상품·후기 등록/삭제·콜백).
 * - 프로덕션 빌드를 띄운 뒤 Playwright(Chromium)로 설치 진입 → 상품 선택 → 미리보기 →
 *   이관 → 자기신고 유입 경로 → 원장 목록 → 삭제 → 결제/환불 콜백 → 모바일 레이아웃까지 확인한다.
 *
 * 실행: npm run test:e2e
 * 필요: Docker, Chromium(/usr/bin/chromium 또는 CHROMIUM_EXECUTABLE),
 *       Playwright(PLAYWRIGHT_MODULE_PATH 또는 로컬 프로젝트 설치).
 */
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const XLSX = require('xlsx');
const postgres = require('postgres');

const ROOT = path.resolve(__dirname, '../..');
const APP_PORT = Number(process.env.E2E_APP_PORT || 3109);
const SHOP_UID = 'e2e-shop';
const CLIENT_ID = 'e2e-client';
const CLIENT_SECRET = 'e2e-client-secret';
const SESSION_SECRET = 'e2e-session-secret';
const APP_ORIGIN = `http://localhost:${APP_PORT}`;
const APP_LOG = '/tmp/makeshop-e2e-app.log';

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE_PATH,
    '/home/giwan/Projects/cafe24-variant-cost-import/node_modules/playwright',
    '/home/giwan/Projects/godomall-quotation-export/node_modules/playwright',
    'playwright',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }
  throw new Error('Playwright를 찾지 못했습니다. PLAYWRIGHT_MODULE_PATH를 지정해 주세요.');
}

function chromiumExecutable() {
  if (process.env.CHROMIUM_EXECUTABLE) return process.env.CHROMIUM_EXECUTABLE;
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

async function waitForDatabase(url) {
  const sql = postgres(url, { connect_timeout: 1 });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await sql`select 1`;
        return;
      } catch (error) {
        if (attempt === 40) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

/** 메이크샵 오픈API 계약을 최소한으로 재현하는 mock. */
function startMockPlatform() {
  const state = { creates: [], deletes: [], payments: [], refunds: [], tokens: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const body = await readBody(req);
    const pathname = url.pathname;

    if (req.method === 'POST' && pathname === '/oauth/token') {
      state.tokens++;
      return sendJson(res, 200, { access_token: 'e2e-access-token', expires_in: 300 });
    }
    if (req.method === 'GET' && pathname === `/api/application/${SHOP_UID}/apps`) {
      return sendJson(res, 200, {
        shop_uid: SHOP_UID,
        installed_at: '2026-10-01T00:00:00+09:00',
        expired_at: '20261231',
      });
    }
    if (req.method === 'GET' && pathname === `/api/v1/${SHOP_UID}/product`) {
      return sendJson(res, 200, {
        return_code: '0000',
        totalCount: '2',
        list: [
          { uid: '1001', product_name: 'E2E 테스트 상품' },
          { uid: '1002', product_name: 'E2E 다른 상품' },
        ],
      });
    }
    if (req.method === 'POST' && pathname === `/api/v1/${SHOP_UID}/review/store`) {
      state.creates.push(JSON.parse(body || '{}'));
      return sendJson(res, 200, { return_code: '0000', datas: { result: true } });
    }
    if (req.method === 'POST' && pathname === `/api/v1/${SHOP_UID}/review/delete`) {
      state.deletes.push(JSON.parse(body || '{}'));
      return sendJson(res, 200, { return_code: '0000', datas: { result: true } });
    }
    if (req.method === 'POST' && pathname === `/api/application/${SHOP_UID}/callback/payment`) {
      state.payments.push(JSON.parse(body || '{}'));
      return sendJson(res, 201, { return_code: '0000' });
    }
    if (req.method === 'POST' && pathname === `/api/application/${SHOP_UID}/callback/refund`) {
      state.refunds.push(JSON.parse(body || '{}'));
      return sendJson(res, 201, { return_code: '0000' });
    }
    return sendJson(res, 404, { error: `unexpected mock path: ${req.method} ${pathname}` });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, state, port: address.port });
    });
  });
}

async function startApp(databaseUrl, apiBase) {
  const env = {
    ...process.env,
    MAKESHOP_CLIENT_ID: CLIENT_ID,
    MAKESHOP_CLIENT_SECRET: CLIENT_SECRET,
    MAKESHOP_SESSION_SECRET: SESSION_SECRET,
    MAKESHOP_API_BASE: apiBase,
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'production',
  };
  delete env.OPENROUTER_API_KEY;
  delete env.MAKESHOP_PROXY_TOKEN;

  if (process.env.E2E_SKIP_BUILD !== '1') {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, env, stdio: 'inherit' });
  }

  const log = fs.openSync(APP_LOG, 'w');
  const child = spawn(path.join(ROOT, 'node_modules/.bin/next'), ['start', '-p', String(APP_PORT)], {
    cwd: ROOT,
    env,
    stdio: ['ignore', log, log],
  });
  let exited = false;
  child.once('exit', () => { exited = true; });

  for (let attempt = 0; attempt < 100; attempt++) {
    if (exited) throw new Error(`앱이 시작되지 못했습니다. 로그: ${APP_LOG}`);
    try {
      const response = await fetch(`${APP_ORIGIN}/api/billing`);
      if (response.status === 401) return { child, log };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`앱 응답 대기 시간 초과. 로그: ${APP_LOG}`);
}

function launchUrl() {
  const timestamp = Date.now();
  const signMessage = `${SHOP_UID}:${timestamp}:install`;
  const hmac = createHmac('sha256', CLIENT_SECRET).update(signMessage).digest('hex');
  const params = new URLSearchParams({
    shop_uid: SHOP_UID,
    timestamp: String(timestamp),
    action_type: 'install',
    hmac,
  });
  return `${APP_ORIGIN}/api/auth/launch?${params}`;
}

function workbookBuffer(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['평점', '리뷰내용', '작성자', '작성일', '옵션', '리뷰이미지'],
    ...rows,
  ]), 'Reviews');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

async function main() {
  const container = `makeshop-review-e2e-${process.pid}`;
  let app;
  let mock;
  let browser;
  let sql;
  let startedContainer = false;

  try {
    console.log('1/6 일회용 PostgreSQL 준비…');
    docker('run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=e2e-local', '-p', '127.0.0.1::5432', 'postgres:17-alpine');
    startedContainer = true;
    const dbPort = docker('port', container, '5432').split(':').at(-1);
    const databaseUrl = `postgres://postgres:e2e-local@127.0.0.1:${dbPort}/postgres`;
    await waitForDatabase(databaseUrl);
    assert.ok(['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname));

    console.log('2/6 메이크샵 API mock 준비…');
    mock = await startMockPlatform();

    console.log('3/6 프로덕션 빌드 + 앱 시작…');
    app = await startApp(databaseUrl, `http://127.0.0.1:${mock.port}`);

    console.log('4/6 브라우저 설치 진입…');
    const { chromium } = loadPlaywright();
    browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
    const pageErrors = [];
    const consoleErrors = [];
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await context.route('**/*', (route) => {
      const target = new URL(route.request().url());
      if (target.hostname === 'localhost' && Number(target.port) === APP_PORT) return route.continue();
      return route.abort();
    });

    await page.goto(launchUrl());
    await page.waitForURL(`${APP_ORIGIN}/admin`);
    await page.getByRole('heading', { name: '리뷰 옮기기' }).waitFor();
    await page.getByRole('heading', { name: '후기 운영 정책을 쇼핑몰에 공개해 주세요' }).waitFor();

    // 정책 안내 → 도움말 페이지가 실제로 열리고 내용이 있는지 확인한다.
    const [help] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('link', { name: /공개 위치·체크리스트·정책 예시 보기/ }).click(),
    ]);
    await help.waitForLoadState('domcontentloaded');
    assert.match(help.url(), /\/admin\/help#review-policy$/);
    await help.getByRole('heading', { name: '후기 운영 정책 공개 안내' }).waitFor();
    assert.match(await help.locator('body').innerText(), /2026년 10월 22일부터/);
    assert.ok(await help.getByRole('link').count() >= 3, '공식 근거 링크가 보여야 합니다.');
    await help.close();

    console.log('5/6 이관 · 원장 · 자기신고 유입 경로 …');
    await page.locator('select').first().locator('option[value="1001"]').waitFor({ state: 'attached' });
    await page.locator('select').first().selectOption('1001');
    await page.locator('input[type=file]').setInputFiles({
      name: 'e2e-reviews.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: workbookBuffer([
        [4, 'E2E 첫 번째 리뷰', 'buyer1', '2026-09-01', '블랙', 'https://example.com/e2e-1.jpg'],
        [5, 'E2E 두 번째 리뷰', 'buyer2', '2026-09-02', '', ''],
      ]),
    });
    await page.getByRole('button', { name: '미리보기' }).click();
    await page.getByText('구매평 2건을 읽었습니다. 아래는 앞 3건입니다.').waitFor();
    await page.getByRole('button', { name: '옮기기' }).click();
    await page.getByText('구매평 2건을 옮겼습니다.').waitFor({ timeout: 60_000 });

    assert.equal(mock.state.creates.length, 2, 'mock에 2건이 등록되어야 합니다.');
    const first = mock.state.creates[0];
    assert.equal(first.uid, '1001');
    assert.equal(first.save_type, 'create');
    assert.equal(first.hname, 'buye****');
    assert.match(first.content, /E2E 첫 번째 리뷰/);
    assert.match(first.content, /\[옵션\] 블랙/);
    assert.equal(first.score_1, '4');
    assert.equal(first.score_5, '4');
    assert.equal(first.date, '2026-09-01 00:00:00');
    assert.equal(first.file_url, 'https://example.com/e2e-1.jpg');
    assert.equal(first.display, 'Y');

    await page.getByText('리뷰이사를 어디에서 알게 되셨나요?').waitFor();
    await page.getByRole('button', { name: '메이크샵 앱스토어·검색' }).click();
    await page.getByText('리뷰이사를 어디에서 알게 되셨나요?').waitFor({ state: 'hidden' });

    const answered = await page.evaluate(() => fetch('/api/source-survey').then((r) => r.json()));
    assert.deepEqual(answered, { answered: true });
    sql = postgres(databaseUrl);
    const surveyRows = await sql`select source, self_reported from makeshop_source_survey where shop_uid = ${SHOP_UID}`;
    assert.deepEqual(surveyRows.map((row) => ({ source: row.source, self: row.self_reported })),
      [{ source: 'makeshop-store-search', self: true }]);

    // 새 세션처럼 sessionStorage를 비우고 한 건 더 옮긴다. DB에 응답이 있으므로 질문은 다시 뜨지 않아야 한다.
    await page.reload();
    await page.evaluate(() => sessionStorage.clear());
    await page.locator('select').first().locator('option[value="1001"]').waitFor({ state: 'attached' });
    await page.locator('select').first().selectOption('1001');
    await page.locator('input[type=file]').setInputFiles({
      name: 'e2e-more.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: workbookBuffer([[5, 'E2E 세 번째 리뷰', 'buyer3', '2026-09-03', '', '']]),
    });
    await page.getByRole('button', { name: '미리보기' }).click();
    await page.getByText('구매평 1건을 읽었습니다. 아래는 앞 3건입니다.').waitFor();
    await page.getByRole('button', { name: '옮기기' }).click();
    await page.getByText('구매평 1건을 옮겼습니다.').waitFor({ timeout: 60_000 });
    assert.equal(mock.state.creates.length, 3);
    await page.waitForTimeout(700);
    assert.equal(await page.getByText('리뷰이사를 어디에서 알게 되셨나요?').count(), 0,
      '이미 응답한 상점에는 질문을 다시 띄우지 않아야 합니다.');

    // 원장 목록 · 선택 삭제 (실제 review/delete 호출까지).
    await page.getByText(/3건 중 1–3건 · 1\/1페이지/).waitFor();
    await page.locator('ul input[type=checkbox]').first().check();
    await page.getByRole('button', { name: '선택 삭제 (1)' }).click();
    await page.getByText('삭제 완료 1건').waitFor({ timeout: 30_000 });
    assert.equal(mock.state.deletes.length, 1);
    assert.equal(mock.state.deletes[0].uid, '1001');
    await page.getByText(/2건 중 1–2건 · 1\/1페이지/).waitFor();

    // 결제/환불 콜백도 같은 세션·같은 mock으로 끝까지 확인한다.
    const payment = await page.evaluate(() => fetch('/api/billing/payment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payment_method: 'CARD' }),
    }).then(async (r) => ({ status: r.status, body: await r.json() })));
    assert.equal(payment.status, 200);
    assert.equal(payment.body.callbackStatus, 201);
    assert.equal(mock.state.payments.length, 1);
    assert.match(mock.state.payments[0].expired_at, /^\d{8}$/);
    const refund = await page.evaluate(() => fetch('/api/billing/refund', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payment_method: 'CARD', refund_reason: 'e2e' }),
    }).then(async (r) => ({ status: r.status, body: await r.json() })));
    assert.equal(refund.status, 200);
    assert.equal(refund.body.callbackStatus, 201);
    assert.equal(mock.state.refunds.length, 1);
    assert.equal(mock.state.refunds[0].partner_order_uid, mock.state.payments[0].partner_order_uid,
      '환불은 원 결제건의 주문번호를 참조해야 합니다.');

    // 모바일 폭에서 가로 스크롤이 생기지 않는지 확인한다.
    await page.goto(`${APP_ORIGIN}/admin`);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: '/tmp/makeshop-e2e-mobile.png', fullPage: true });

    assert.deepEqual(pageErrors, [], '페이지 런타임 오류가 없어야 합니다.');
    const relevantConsoleErrors = consoleErrors.filter((message) => !/favicon|net::ERR_FAILED/.test(message));
    assert.deepEqual(relevantConsoleErrors, [], '콘솔 오류가 없어야 합니다.');

    console.log('6/6 통과');
    console.log(JSON.stringify({
      shop: SHOP_UID,
      platformCreates: mock.state.creates.length,
      platformDeletes: mock.state.deletes.length,
      payments: mock.state.payments.length,
      refunds: mock.state.refunds.length,
      survey: surveyRows[0],
      ledgerAfterDelete: 2,
      mobileScreenshot: '/tmp/makeshop-e2e-mobile.png',
    }, null, 2));
  } finally {
    try { await sql?.end({ timeout: 1 }); } catch {}
    try { await browser?.close(); } catch {}
    try { app?.child.kill('SIGTERM'); } catch {}
    try { if (app?.log) fs.closeSync(app.log); } catch {}
    try { mock?.server.close(); } catch {}
    if (startedContainer) {
      try { docker('stop', container); } catch (error) { console.error(`컨테이너 정리 실패: ${error.message}`); }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
