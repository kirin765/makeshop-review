// 스토어 상세 이미지 재생성: store-assets/detail-images.html의 #s1..#s6 → public/store/detail-0X.png
// 심사/스토어 노출용 — "무료" 문구가 "무료체험 14일"로 바뀐 버전을 렌더링한다.
// 실행: node scripts/render-store-images.mjs
import { chromium } from '/home/giwan/Projects/reviewboost/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'store-assets', 'detail-images.html');
const outDir = path.join(root, 'public', 'store');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 1 });
  await page.goto(`file://${src}`);
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(400);

  for (let i = 1; i <= 6; i++) {
    const el = await page.$(`#s${i}`);
    if (!el) throw new Error(`section #s${i} not found`);
    const out = path.join(outDir, `detail-0${i}.png`);
    await el.screenshot({ path: out });
    const box = await el.boundingBox();
    console.log(`detail-0${i}.png  ${Math.round(box.width)}x${Math.round(box.height)}  → ${out}`);
  }
} finally {
  await browser.close();
}