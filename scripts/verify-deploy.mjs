// 배포 검증: 새 빌드(399e293)가 라이브에 반영됐는지 확인
// - 새 admin chunk(3pog0hv06qehx.js)가 200으로 서빙되는지
// - /admin HTML이 새 chunk를 참조하는지 (이전 빌드는 1tp7oqqwygmfe.js)
// - /api/billing 라우트가 살아있는지 (세션 없으면 401)
// - store/detail-01.png가 로컬 최종본과 같은지
// 실행: node scripts/verify-deploy.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = 'https://makeshop-review-gamma.vercel.app';
const NEW_ADMIN_CHUNK = '3pog0hv06qehx.js';
const OLD_ADMIN_CHUNK = '1tp7oqqwygmfe.js';

async function get(path) {
  const res = await fetch(BASE + path, { redirect: 'follow' });
  return { status: res.status, text: await res.text() };
}

const chunkRes = await get(`/_next/static/chunks/${NEW_ADMIN_CHUNK}`);
console.log(`[1] 새 admin chunk ${NEW_ADMIN_CHUNK}: HTTP ${chunkRes.status} ${chunkRes.status === 200 ? '✅ 반영됨' : '❌ 아직 미반영'}`);

const admin = await get('/admin');
const refsNew = admin.text.includes(NEW_ADMIN_CHUNK);
const refsOld = admin.text.includes(OLD_ADMIN_CHUNK);
console.log(`[2] /admin HTML: 새 chunk 참조 ${refsNew ? '✅' : '❌'} / 옛 chunk 참조 ${refsOld ? '❌(구버전)' : '✅(구버전 아님)'}`);

const billing = await get('/api/billing');
console.log(`[3] /api/billing (세션 없음): HTTP ${billing.status} ${billing.status === 401 ? '✅ 라우트 정상' : '⚠️ ' + billing.text.slice(0, 120)}`);

const localPng = readFileSync(new URL('../public/store/detail-01.png', import.meta.url));
const localHash = createHash('sha256').update(localPng).digest('hex').slice(0, 16);
const pngRes = await fetch(`${BASE}/store/detail-01.png`);
const liveHash = createHash('sha256').update(Buffer.from(await pngRes.arrayBuffer())).digest('hex').slice(0, 16);
console.log(`[4] store/detail-01.png: local ${localHash} / live ${liveHash} ${localHash === liveHash ? '✅ 신규 이미지 반영' : '❌ 불일치'}`);

const ok = chunkRes.status === 200 && refsNew && !refsOld && billing.status === 401 && localHash === liveHash;
console.log(ok ? '\n=== 모두 통과 — 새 빌드가 라이브입니다 ===' : '\n=== 일부 미반영 — 위 항목 확인 ===');