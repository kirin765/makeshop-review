# Makeshop bulk-transfer update — 2026-09-14

Ports the Cafe24 transfer safeguards to this platform's own API and ledger. No customer reviews were created or deleted during validation.

## Changes

- Persist a platform-specific claim before every remote write. Retain successful and uncertain claims across browser retries and server restarts. Release only definite non-writes or confirmed app-managed deletions.
- Require a configured, working ledger before posting; report success only after recording the confirmed write. Reject malformed responses and partial results whose row identities are unknown.
- Assign occurrence identities across the entire file, preserving intentional identical reviews across request boundaries. Preserve legacy hash matching by multiplicity.
- Parse spreadsheets in a Web Worker, preserve dates and every photo column, validate rather than truncate content/ratings/photos, and fingerprint the file with SHA-256.
- Resume only from a completely successful contiguous prefix. Retry only server-identified unwritten rows, stop on unknown outcomes, and honor Stop before another dispatch.
- Route multipart imports through the same validated batch flow. Reject oversized requests explicitly.
- Reserve free usage atomically before writing. Paid transfers bypass the free counter; retain server-confirmed plan state in progress. Unknown original writes retain their reservation; blocked replays do not charge again.
- Clear browser checkpoints for explicit deletions, release corresponding claims transactionally, and recheck the remaining final page after partial deletion.

## Platform-specific behavior

Makeshop writes one review per remote request and immediately records each successful response. The old 10-review unrecorded window is removed. Request timeouts and the 45-second handler budget bound stalled calls; the existing 150 ms pacing is retained.

The current official API documents `date` for creation and `file_url` through `file_url_4`. The payload now uses those fields, preserves all five rating fields, and requires explicit success in `return_code` and `datas.result`. Photos support JPG/PNG/GIF, up to four URLs; Makeshop imposes a 500 KB limit per file and combines them into one image. The app validates count/format and reports remote size rejection; it does not fetch or recompress the files. Old text-only imports need manual review before adding photos to the same reviews.

Paid requests skip free-usage reads. Free quota uses a shared pool and atomic reservations; expiry/refund still blocks paid access according to the existing subscription store.

Official API reference: [Makeshop review documentation](https://openapi.makeshop.co.kr/guide/documents_test/openapi/26), also available from [the API documentation](https://openapi.makeshop.co.kr/docs).

## Verification

- `npm test`: parser, occurrence identities, client checkpoints, subset retries, timeouts, uncertain outcomes, ledger failures, request limits, paid-plan progress, and platform response/payload checks.
- `npm run test:db`: disposable local PostgreSQL 17 only. Covers concurrent claims/reservations, restart protection, legacy duplicates, paid access, verified deletion, and a 25,000-review full client → route → writer → database transfer.
- The stress test preserved exactly 25,000 remote mock records and 25,000 ledger rows, including 1,000 contents repeated 25 times. It injected 260 throttled responses, a lost remote response, and a lost browser response. The unknown write resumed only after simulated verified reconciliation. Complete-file replay created zero additional reviews.
- Real production browser worker: 50,000 rows, SHA-256 verified, transferred input buffer, UI heartbeat active. Local measurement: 780 ms; 76 main-thread callbacks.
- Lint, TypeScript, and production build. Makeshop also has two pre-existing unused-variable lint warnings in its billing demo script.

The 25,000-review run uses mocked platform calls and simulated pacing; it proves the tested failure behavior, not live throughput. The browser check measures local parsing, not a platform transfer.

To reproduce the browser check, build and start the app locally, then run `node scripts/tests/verify-browser-worker.cjs` with `TEST_APP_URL=http://127.0.0.1:PORT/support`. Optional `PLAYWRIGHT_MODULE_PATH` and `CHROMIUM_EXECUTABLE` select an existing Playwright/browser installation. Only loopback network requests are permitted by this harness.

## Rollout and recovery

Schema changes are additive and use app-specific table names. Claims never expire automatically. A crash can occur between claim creation and posting, or between posting and ledger persistence; such rows stay blocked until verified. The original complete spreadsheet and selected product are required to reconstruct occurrence hashes. Verify complete review text, writer, rating, date, options, and photos before recording a known remote success or releasing a proven non-write. Quota reservations interrupted during persistence may also require reconciliation.

Transfers pause when the browser closes and resume with the same complete file. Historical orphan posts or older content alterations cannot be repaired automatically. A live paid-shop transfer of at least 25,000 reviews, including photos, stop/resume, and complete-file replay, remains pending. No live-volume stability guarantee is implied by the local tests.

## 자기신고 유입 경로 — 2026-10-30

`cafe24-review` 64d1b13(이관 성공 후 자기신고 유입 경로 질문)을 메이크샵 세션·DB 구조에 맞게 이식했다.

- **저장**: `makeshop_source_survey`(shop_uid 기본키, source CHECK, `self_reported=true`, `responded_at`). 최초 응답만 저장하고 건너뛰기도 응답으로 기록한다. 결제 원장·사용량 테이블과 분리되어 있으며 유료 판정에 쓰지 않는다.
- **API**: `GET /api/source-survey`는 세션 상점의 응답 여부, `POST`는 `{source}` 하나만 받아 저장한다. 세션 없음 401, 잘못된/초과 본문 400, 저장소 오류 503. 쿼리·본문의 shop_uid는 신뢰하지 않는다.
- **UI**: 실제 등록이 1건 이상 끝난 성공 결과에서만 `source-survey.tsx`를 마운트한다. 이미 응답한 상점(DB)이나 이번 세션에서 질문을 본 경우에는 다시 띄우지 않는다. 답을 저장하지 못해도 이관·결제·재시도 흐름은 막지 않는다.
- **선택지**: 메이크샵 앱스토어·검색 / 다른 무료 앱 / 블로그·커뮤니티 / 지인 추천 / 기타 / 건너뛰기. 카페24 전용 선택지(옵션별 상세설명·순수익 자동 계산·카페24 스토어)는 이식하지 않았다.

자동 검증:

- `npm test`: 라우트 인증·본문 검증·값 검증, 기존 이관 테스트, 삭제 reg_date 폴백을 포함한 28개 통과.
- `npm run test:db`: 일회용 PostgreSQL 17에서 최초 응답 우선, 상점별 분리, CHECK 제약, 결제와의 분리를 포함한 9개 테스트 통과.
- `npm run test:e2e`: 일회용 PostgreSQL + 메이크샵 API mock + 프로덕션 빌드 + Chromium으로 설치 진입 → 정책 도움말 → 2건 이관 → 유입 경로 응답·DB 확인 → 재방문 시 미노출 → 원장 목록 → 선택 삭제 → 결제/환불 콜백(HTTP 201, 원 주문번호 참조) → 모바일 가로 스크롤 없음까지 확인했다. 모든 플랫폼 호출은 mock이며 실제 고객 리뷰·실제 메이크샵 API는 쓰지 않는다.

E2E는 Docker, Chromium, Playwright가 필요하다. Playwright는 `PLAYWRIGHT_MODULE_PATH`, 브라우저는 `CHROMIUM_EXECUTABLE`로 지정할 수 있고, 이미 빌드된 결과를 쓰려면 `E2E_SKIP_BUILD=1`을 준다. 앱 로그는 `/tmp/makeshop-e2e-app.log`, 모바일 스크린샷은 `/tmp/makeshop-e2e-mobile.png`에 남는다.

## 라이브 설치·검증 — 2026-10-30

실제 메이크샵 테스트 몰 `hello765`(파트너 기본 몰)에서 설치 진입부터 이관·유입 경로·삭제·결제/환불까지 실행했다. 조회·검증은 기존 설치를 사용했고, 실제 고객몰은 사용하지 않았다.

### 배포

- Vercel production: `76916ac` → `https://makeshop-review-gamma.vercel.app` (설치된 APP URL과 일치).
- VPS: `20261030T054910Z-6424fc`(유입 경로·정책), `20261030T060341Z-96f54d`(삭제 폴백) prepare→activate. `https://makeshop-review.onnurimun.com`에서 `/admin`, `/admin/help` 200·`/api/source-survey` 401 확인.
- 메이크샵 개발정보 관리의 **접근 허용 IP**에 VPS 프록시 egress `49.247.192.39`를 추가했다(기존 `61.254.69.43` 유지). 추가 전 토큰 발급은 `403 access_denied`, 추가 후 201·상품 조회 200을 확인했다.

### 라이브 결과

- 설치 앱 정보: `app_name=리뷰이사`, `app_url=https://makeshop-review-gamma.vercel.app/`, `installed_at=2026-09-29`.
- 파트너센터 **테스트 실행** → `https://makeshop-review-gamma.vercel.app/admin`(shop_uid=hello765) 실제 오픈, 정책 안내 노출. 앱 자체 게이트는 만료 상태라 결제 안내가 표시됐다.
- hmac launch → `/admin` 세션 발급, `/api/products` 3개 상품 조회.
- 결제 콜백 201 → 유료 전환, `review/store` 1건 등록(`written=1`).
- 유입 경로 `POST /api/source-survey` 204, `GET` `answered=true`, DB `self_reported=true` 확인.
- **삭제 실측 버그**: 등록 요청 `date=2026-10-30 14:55:00`과 달리 실제 저장 `reg_date=2026-10-30 14:58:18`. 원장 작성일로 삭제하니 `return_code=9999 "검색된 리뷰가 없습니다."`가 났다.
- 수정 후: 1차 삭제 9999 → `imported_at` 전후 `/review` 조회로 실제 `reg_date` 발견 → 그 값으로 재삭제 0000 → 원장 0건. 새 리뷰를 다시 등록해 같은 create→delete 사이클을 재검증했고, Makeshop `/review` 조회에서 테스트 마커가 0건임을 확인했다.
- 환불 콜백 201(원 결제건 `partner_order_uid` 재사용), 테스트 유입 경로 행과 원장 행은 삭제해 정리했다.

### 남은 상태·부작용

- 테스트 결제/환불 2쌍이 `hello765` 파트너센터 주문·환불 내역에 테스트 데이터로 남아 있다(실제 고객 결제 아님).
- 환불 콜백의 `expired_at` 덮어쓰기 규칙 때문에 앱 설치 만료일이 기존 `9999-12-31`에서 `2026-10-30`으로 바뀌었다. 테스트 몰은 앱 자체 게이트에서도 만료 상태이며, 재사용하려면 결제로 연장해야 한다.
- 30일이 지난 원장 행은 Makeshop 조회 API로 실제 `reg_date`를 찾을 수 없어 앱이 삭제를 거부하고 쇼핑몰 관리자에서 직접 삭제하도록 안내한다.

## Vercel → VPS 이전 — 2026-10-30

- 메이크샵 개발정보 관리의 **APP URL**을 `https://makeshop-review.onnurimun.com/`로 변경·저장했다.
  - 저장 후 `GET /api/application/hello765/apps`: `app_url=https://makeshop-review.onnurimun.com/`,
    `installed_at=2026-10-30`, `expired_at=9999-12-31`.
  - 파트너센터 **테스트 실행** → `https://makeshop-review.onnurimun.com/admin`(shop_uid=hello765) 실제 오픈.
  - VPS 앱은 `app-makeshop-review.service`(127.0.0.1:3002)로 동작하며, 설치는 기존 VPS 배포
    `20261030T054910Z-6424fc` + `20261030T060341Z-96f54d`를 사용했다.
- VPS 앱 env `MAKESHOP_APP_URL`은 이미 새 호스트를 가리키고 있었다. 남아 있던 만료 구독 캐시
  (`makeshop_subscription`의 hello765 행)를 지워 Makeshop의 `9999-12-31`을 다시 읽게 했고,
  `/api/billing` trial·`/api/products` 200·3개 상품을 확인했다.
- `node scripts/verify-deploy.mjs` 통과: `/admin`·chunk 8개·`/api/billing` 401·`/api/source-survey` 401·
  `/admin/help` 정책 안내·store 이미지 hash·옛 Vercel 호스트 미참조.
- DNS·Cloudflare tunnel은 기존 `makeshop-review.onnurimun.com` 라우트를 그대로 사용했다(변경 없음).
- `store-detail.html`의 절대 이미지 URL을 VPS 호스트로 바꿨다. **실제 메이크샵 스토어 상세페이지에
  이미 붙여 넣은 HTML은 별도로 갱신해야 한다** — Vercel 프로젝트를 삭제하기 전에 확인할 것.
- Vercel 프로젝트(`makeshop-review-gamma`)는 롤백용으로 남겨 두었다. 삭제는 스토어 상세 이미지 URL을
  모두 VPS로 바꾼 뒤 별도로 요청해야 한다.
