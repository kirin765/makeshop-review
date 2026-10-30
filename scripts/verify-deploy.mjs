// VPS 배포 검증 — 현재 라이브(VPS) 빌드가 최종 상태인지 동적으로 확인한다.
// - /admin이 참조하는 모든 chunk가 200인지
// - /api/billing·/api/source-survey가 세션 없이 401인지
// - /admin/help에 후기 정책 안내가 있는지
// - public/store 이미지 hash가 로컬과 일치하는지
// - 응답이 옛 Vercel 호스트를 참조하지 않는지
// 실행: node scripts/verify-deploy.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = process.env.VERIFY_BASE || 'https://makeshop-review.onnurimun.com';

async function get(path) {
  const res = await fetch(BASE + path, { redirect: 'follow' });
  return { status: res.status, text: await res.text() };
}

let ok = true;
const check = (label, pass, detail = '') => {
  console.log(`${pass ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) ok = false;
};

// 1) /admin과 참조 chunk
const admin = await get('/admin');
check('/admin HTTP 200', admin.status === 200, `HTTP ${admin.status}`);
const refs = [...new Set(
  [...admin.text.matchAll(/_next\/static\/chunks\/([^"\\]+)\.js/g)].map((m) => m[1] + '.js'),
)].filter((c) => !c.startsWith('turbopack'));
let chunksOk = true;
for (const c of refs) {
  const r = await get(`/_next/static/chunks/${c}`);
  if (r.status !== 200) {
    console.log(`   chunk ${c}: HTTP ${r.status}`);
    chunksOk = false;
  }
}
check(`/admin 참조 chunk ${refs.length}개`, chunksOk);

// 2) 인증이 필요한 라우트
const billing = await get('/api/billing');
check('/api/billing (세션 없음) HTTP 401', billing.status === 401, `HTTP ${billing.status}`);
const survey = await get('/api/source-survey');
check('/api/source-survey (세션 없음) HTTP 401', survey.status === 401, `HTTP ${survey.status}`);

// 3) 후기 정책 도움말
const help = await get('/admin/help');
check('/admin/help HTTP 200', help.status === 200, `HTTP ${help.status}`);
check('/admin/help 후기 정책 안내', help.text.includes('후기 운영 정책 공개 안내'));

// 4) 스토어 이미지 hash
const localPng = readFileSync(new URL('../public/store/detail-01.png', import.meta.url));
const localHash = createHash('sha256').update(localPng).digest('hex').slice(0, 16);
const pngRes = await fetch(`${BASE}/store/detail-01.png`);
const liveHash = createHash('sha256').update(Buffer.from(await pngRes.arrayBuffer())).digest('hex').slice(0, 16);
check('store/detail-01.png hash', localHash === liveHash, `local ${localHash} / live ${liveHash}`);

// 5) 옛 Vercel 호스트 미참조
const oldHost = /makeshop-review-gamma\.vercel\.app/.test(admin.text + help.text);
check('옛 Vercel 호스트 미참조', !oldHost);

console.log(ok ? '\n=== 모두 통과 — VPS 최종 빌드가 라이브입니다 ===' : '\n=== 일부 미반영 ===');
if (!ok) process.exitCode = 1;
