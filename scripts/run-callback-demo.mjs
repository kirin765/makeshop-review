// 심사 보류 해소 데모: 테스트 몰(hello765)에서 결제/환불 콜백을 실제 호출한다.
// 흐름: hmac launch → 세션 → GET /api/billing → PAYMENT(F) → REFUND(G) → PAYMENT(F 복구)
// 실행: node scripts/run-callback-demo.mjs   (참조: ~/makeshop-secrets.env)
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const env = Object.fromEntries(
  readFileSync(`${homedir()}/makeshop-secrets.env`, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const BASE = 'https://makeshop-review-gamma.vercel.app';
const SHOP = 'hello765';

const cookies = {};
async function rawFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  const cs = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (cs) headers.set('cookie', cs);
  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  const setc = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const sc of setc) {
    const pair = sc.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) cookies[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return res;
}
async function req(path, init = {}) {
  return rawFetch(path.startsWith('http') ? path : BASE + path, init);
}
async function json(res, label) {
  const text = await res.text();
  let d = {}; try { d = JSON.parse(text); } catch { d = { raw: text.slice(0, 200) }; }
  console.log(`[${label}] HTTP ${res.status}`, JSON.stringify(d).slice(0, 500));
  return d;
}

// 1) hmac launch → 세션 발급
const ts = Date.now();
const hmac = createHmac('sha256', env.MAKESHOP_CLIENT_SECRET)
  .update(`${SHOP}:${ts}:install`).digest('hex');
const launchUrl = `/?shop_uid=${SHOP}&timestamp=${ts}&action_type=install&hmac=${hmac}`;
let r = await req(launchUrl);
console.log(`[launch] HTTP ${r.status} → ${r.headers.get('location') ?? '(none)'}`);
if (r.status === 307 || r.status === 302) {
  r = await req(r.headers.get('location'));
  console.log(`[launch→auth] HTTP ${r.status} → ${r.headers.get('location') ?? '(none)'} cookies=${Object.keys(cookies)}`);
  if (r.status === 307 || r.status === 302) await req(r.headers.get('location'));
}
if (!cookies.mshop_sess) { console.log('❌ 세션 발급 실패 (hmac 불일치? 세션 시크릿 상이?)'); process.exit(1); }
console.log(`✅ 세션 발급: mshop_sess=${String(cookies.mshop_sess).slice(0, 18)}…`);

// 2) 현재 구독 상태
const before = await json(await req('/api/billing'), '구독(전)');

// 3) F — 결제 → payment 콜백 201
const pay1 = await json(await req('/api/billing/payment', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ payment_method: 'CARD' }),
}), '결제 F1');
console.log(pay1.callbackStatus === 201 ? '  ✅ payment 콜백 201 — 판매관리 주문 내역에 기록됨' : '  ⚠️ 위 결과 확인');

// 4) G — 환불 → refund 콜백 201
const refund = await json(await req('/api/billing/refund', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ payment_method: 'CARD', refund_reason: '심사 데모 — 환불 콜백 연동 확인' }),
}), '환불 G');
console.log(refund.callbackStatus === 201 ? '  ✅ refund 콜백 201 — 판매관리 환불 내역에 기록됨' : '  ⚠️ 위 결과 확인');

// 5) F — 재결제로 유료 상태 복구
const pay2 = await json(await req('/api/billing/payment', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ payment_method: 'CARD' }),
}), '결제 F2(복구)');

// 6) 최종 상태 + 이력
const after = await json(await req('/api/billing'), '구독(후)');
if (after.subscription) {
  console.log(`\n최종 구독: ${after.subscription.status} / 만료일 ${after.subscription.expiredAt} / D-${after.subscription.daysLeft}`);
}
if (Array.isArray(after.history)) {
  for (const h of after.history) console.log(`  이력: ${h.kind} ${h.amount}원 → callback ${h.callbackStatus}`);
}