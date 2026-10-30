/* eslint-disable @typescript-eslint/no-require-imports -- Node test harness uses CommonJS to inject boundary mocks. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./load-source.cjs');

const SOURCES = ['makeshop-store-search', 'other-free-app', 'blog-community', 'referral', 'other', 'skipped'];

function routeWith(session, overrides = {}) {
  return loadSource('src/app/api/source-survey/route.ts', {
    '@/lib/launch': { sessionShop: async () => session.shopUid },
    '@/lib/sourceSurvey': {
      hasResponded: async (shopUid) => shopUid === 'answered-shop',
      isSourceValue: (value) => SOURCES.includes(value),
      recordSource: async () => {},
      ...overrides,
    },
  });
}

test('GET reports whether the shop already answered', async () => {
  const fresh = await routeWith({ shopUid: 'fresh-shop' }).GET();
  assert.equal(fresh.status, 200);
  assert.deepEqual(await fresh.json(), { answered: false });
  const answered = await routeWith({ shopUid: 'answered-shop' }).GET();
  assert.deepEqual(await answered.json(), { answered: true });
});

test('GET without a session is 401', async () => {
  assert.equal((await routeWith({ shopUid: null }).GET()).status, 401);
});

test('POST stores exactly the session shop and a fixed source value', async () => {
  const recorded = [];
  const route = routeWith({ shopUid: 'shop1' }, { recordSource: async (...args) => recorded.push(args) });
  const response = await route.POST({ text: async () => JSON.stringify({ source: 'makeshop-store-search' }) });
  assert.equal(response.status, 204);
  assert.deepEqual(recorded, [['shop1', 'makeshop-store-search']]);
});

test('POST rejects forged, unknown and oversized payloads', async () => {
  let calls = 0;
  const route = routeWith({ shopUid: 'shop1' }, { recordSource: async () => { calls++; } });
  const post = (body) => route.POST({ text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  assert.equal((await post({ source: 'utm' })).status, 400);
  assert.equal((await post({ source: 'other', shopUid: 'other' })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post('x'.repeat(300))).status, 400);
  assert.equal(calls, 0);
});

test('POST is 401 without a session and 503 when storage fails', async () => {
  const anonymous = routeWith({ shopUid: null });
  assert.equal((await anonymous.POST({ text: async () => JSON.stringify({ source: 'other' }) })).status, 401);
  const failing = routeWith({ shopUid: 'shop1' }, { recordSource: async () => { throw new Error('db down'); } });
  assert.equal((await failing.POST({ text: async () => JSON.stringify({ source: 'other' }) })).status, 503);
});

test('the survey source list is value-checked before storage', () => {
  const survey = loadSource('src/lib/sourceSurvey.ts', { postgres: () => {} });
  for (const source of SOURCES) assert.equal(survey.isSourceValue(source), true);
  for (const source of ['utm', 'profit', 'cafe24-store-search', '', null]) assert.equal(survey.isSourceValue(source), false);
});
