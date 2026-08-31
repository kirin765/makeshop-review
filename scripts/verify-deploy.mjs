// 배포 검증: 현재 라이브 빌드가 최종 상태인지 동적으로 확인
// - /admin이 참조하는 모든 chunk가 200으로 서빙되는지 + 옛 admin chunk(구버전 마커) 미참조
// - /api/billing 라우트 정상(세션 없으면 401), 진단 라우트 제거(404), store 이미지 hash 일치
// 실행: node scripts/verify-deploy.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = 'https://makeshop-review-gamma.vercel.app';
// 이전 배포(399e293 이전)의 admin chunk — 여전히 참조되면 구버전이다
const OLD_ADMIN_CHUNKS = ['1tp7oqqwygmfe.js'];

async function get(path) {
  const res = await fetch(BASE + path, { redirect: 'follow' });
  return { status: res.status, text: await res.text() };
}

// 1) /admin이 참조하는 chunk 전부 200 확인 + 옛 chunk 미참조
const admin = await get('/admin');
const refs = [...admin.text.matchAll(/_next\/static\/chunks\/([^"\\]+)\.js/g)].map((m) => m[1] + '.js');
const uniqRefs = [...new Set(refs)].filter((c) => !c.startsWith('turbopack'));
let refOk = true;
for (const c of uniqRefs) {
  const r = await get(`/_next/static/chunks/${c}`);
  if (r.status !== 200) { console.log(`[1] chunk ${c}: HTTP ${r.status} ❌`); refOk = false; }
}
console.log(`[1] /admin 참조 chunk ${uniqRefs.length}개 전부 200 ${refOk ? '✅' : '❌'}`);
const oldRef = OLD_ADMIN_CHUNKS.some((c) => admin.text.includes(c));
console.log(`[2] 옛 admin chunk 참조 ${oldRef ? '❌(구버전)' : '✅(구버전 아님)'}`);

// 2) 라우트 상태
const billing = await get('/api/billing');
console.log(`[3] /api/billing (세션 없음): HTTP ${billing.status} ${billing.status === 401 ? '✅' : '⚠️'}`);
const diag = await get('/api/diag/token?shop_uid=hello765');
console.log(`[4] /api/diag/token (제거 확인): HTTP ${diag.status} ${diag.status === 404 ? '✅ 제거됨' : '⚠️'}`);

// 3) 스토어 이미지 hash
const localPng = readFileSync(new URL('../public/store/detail-01.png', import.meta.url));
const localHash = createHash('sha256').update(localPng).digest('hex').slice(0, 16);
const pngRes = await fetch(`${BASE}/store/detail-01.png`);
const liveHash = createHash('sha256').update(Buffer.from(await pngRes.arrayBuffer())).digest('hex').slice(0, 16);
console.log(`[5] store/detail-01.png: local ${localHash} / live ${liveHash} ${localHash === liveHash ? '✅' : '❌'}`);

const ok = refOk && !oldRef && billing.status === 401 && diag.status === 404 && localHash === liveHash;
console.log(ok ? '\n=== 모두 통과 — 최종 빌드가 라이브입니다 ===' : '\n=== 일부 미반영 ===');