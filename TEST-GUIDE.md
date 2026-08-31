# 설치·재접속 테스트 가이드

> 메이크샵 앱 "리뷰이사"(`makeshop-review`)의 **설치 / 재접속("앱 관리하기")** 플로우 테스트 절차서.
> 다른 에이전트가 이 문서만 읽고 실행할 수 있게 모든 절차와 함정을 적었다.

---

## 1. 앱 개요

| 항목 | 값 |
|---|---|
| 프로젝트 | `makeshop-review` (Next.js App Router, Vercel) |
| 프로덕션 URL | **https://makeshop-review-gamma.vercel.app** |
| 메이크샵 client_id | `08368787-0c51-4a6b-a4af-714154b9fc5d` |
| client_secret | `.env`의 `MAKESHOP_CLIENT_SECRET` |
| APP URL | `https://makeshop-review-gamma.vercel.app/` (루트) |
| 테스트 몰 | `hello765` (파트너 기본 몰) |
| API 경유 | 홈서버 프록시 `https://makeshop-proxy.sajangbu.com` (egress = 등록 IP 61.254.69.43 — 2026-08-26 LAN 변경으로 변경, 재등록 필요. 이전: 218.237.176.17) |
| DB | Vercel env `DATABASE_URL` (Neon Postgres) — 토큰 캐시·사용량 |

**핵심 코드 파일**

- 설치 진입·hmac 검증·세션: `src/lib/launch.ts`, `src/app/api/auth/launch/route.ts`, `src/app/page.tsx`
- 토큰 발급·캐시: `src/lib/makeshop.ts`, `src/lib/token.ts`, `src/lib/store.ts`
- 상품/후기 API: `src/app/api/products/route.ts`, `src/app/api/reviews/route.ts`

---

## 2. 메이크샵 설치 연동 개요 (공식 문서 실측 2026-08-13)

메이크샵은 **OAuth가 없다.** 설치와 재접속이 모두 APP URL로
`?shop_uid={shop_uid}&timestamp={timestamp}&action_type={action_type}&hmac={hmac}`을 GET으로 보낸다.

**HMAC 규칙 (docs/guide/app/install):**

```
signMessage = {shop_uid}:{timestamp}:{action_type}   ← 콜론 구분
hmac        = HMAC-SHA256(signMessage, CLIENT_SECRET) → hex
timestamp   = Unix epoch **밀리초**, 현재와 ±5분(300,000ms) 안
```

> 🚨 **카페24와 반대다.**
> - 카페24: 정렬된 쿼리스트링 전체 + base64 + ±2시간
> - 메이크샵: `shop_uid:timestamp:action_type` 3개만 + **hex** + ±5분(ms)
> 포팅할 때 옛 코드를 그대로 가져오면 안 된다.

**토큰 (docs/guide/app/access-token):**

```
POST https://connect.makeshop.co.kr/oauth/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded
grant_type=client_credentials&shop_uid={shop_uid}
→ data.access_token (5분 유효), data.expires_in
```

- **5분 유효**, **(shop_uid, IP)당 1분 최대 5회** — 캐시 필수. `getValidToken`이 DB에서 60초 skew로 재발급.
- 리프레시 토큰 없음. 재발급 = 재발급.
- ⚠️ **접근 허용 IP**: 개발정보 관리에 등록된 IP에서만 API 열림(최대 10개). Vercel egress IP를 등록해야 한다.

**상점 설치 앱 정보 조회 (선택):**
```
GET https://connect.makeshop.co.kr/api/application/{shop_uid}/apps?client_id={client_id}
→ data.installed_at, data.expired_at   (expired_at: 설치 시 무료체험 기간에 따라 자동 결정)
```

**유료앱 결제/환불 콜백 (docs/guide/app/orders-callback-api — 심사 필수):**
```
POST https://connect.makeshop.co.kr/api/application/{shop_uid}/callback/payment   → 성공 201
POST https://connect.makeshop.co.kr/api/application/{shop_uid}/callback/refund    → 성공 201
body: { client_id, partner_order_uid, amount, payment_method, expired_at?("YYYYMMDD"), refund_reason? }
```
- `expired_at`은 결제/환불 관계없이 **앱 설치 만료일로 강제 덮어쓰기**된다.
- 액세스 토큰 발급 시 사용한 client_id·shop_uid와 동일해야 올바른 설치 정보를 조회할 수 있다.
- 무료체험 종료/만료 후 이용 제한은 파트너사(우리)가 자체 처리한다 → `quota.ts` 402 paywall.
- 앱 내 구현: `src/lib/billing.ts` (`processPayment`·`processRefund`), 엔드포인트 `/api/billing/payment`·`/api/billing/refund`
  (`MAKESHOP_BILLING_KEY` 미설정 = 상점 세션 허용 데모 모드, 설정 = PG 웹훅 전용).

---

## 3. 테스트 환경 준비

### 3.1 로컬 환경변수 (`.env.local`)

```
MAKESHOP_CLIENT_ID=
MAKESHOP_CLIENT_SECRET=
MAKESHOP_APP_URL=https://<prod>/
MAKESHOP_SESSION_SECRET=<랜덤>
DATABASE_URL=
```

### 3.2 접근 허용 IP 확인

메이크샵 API는 개발정보 관리의 **접근 허용 IP**에 등록된 IP에서만 호출된다.
로컬 개발은 집 공인 IP를, 운영은 Vercel egress IP를 등록해야 한다.
(2026-08-26 LAN 변경: 홈 공인 IP가 `218.237.176.17` → `61.254.69.43`으로 바뀜 — 개발자센터에 재등록 필요)

```bash
curl -s https://api.ipify.org   # 로컬 공인 IP
```

### 3.3 빌드·배포

```bash
npm run build
VERCEL_ORG_ID=$ORG VERCEL_PROJECT_ID=$PROJ npx vercel deploy --prod --yes
```

---

## 4. hmac 검증 (앱 실행 URL 만들기)

개발자센터 → 상품 > App > 개발정보 관리 → 하단 **테스트 실행**이 진짜 설치 흐름이다.
수동 확인이 필요하면 아래 스크립트로 APP URL을 만들어 붙인다.

```bash
node -e '
const { createHmac } = require("crypto");
const SECRET = "<client_secret>";
const shopUid = "<테스트 shop_uid>";
const ts = Date.now();  // 밀리초
const actionType = "install";
const msg = `${shopUid}:${ts}:${actionType}`;
const hmac = createHmac("sha256", SECRET).update(msg).digest("hex");
console.log(`https://<prod>/?shop_uid=${shopUid}&timestamp=${ts}&action_type=${actionType}&hmac=${hmac}`);
'
```

**예상 응답:**
- hmac 일치 + timestamp 신선 → `307 Location: /admin` (세션 발급)
- hmac 불일치 → `401 {"error":"invalid launch request"}`
- timestamp 5분 초과 → `401`

---

## 5. 테스트 시나리오

### 5.1 시나리오 A — 최초 설치 완주

1. 파트너센터 → 상품 > App > 개발정보 관리 → **테스트 실행**
2. APP URL(`/` → `/api/auth/launch`) 호출 → hmac 통과 → `/admin` 307
3. `/admin`이 "리뷰 옮기기" UI + shop_uid + 상품 목록 표시
4. `curl /api/billing`(세션 쿠키 포함) → `subscription.status` 정상 응답
   (진단 라우트 `/api/diag/*`는 심사 전에 제거했음 — 테스트는 `/api/billing`·DB로 확인)

**통과 기준**: 상품 목록이 채워진다 (토큰 발급 + 상품 API 통과).

### 5.2 시나리오 B — 재접속 (앱 관리하기)

1. shop_uid 세션이 살아있는 상태에서 APP URL 재호출
2. **통과 기준**: OAuth가 없으므로 항상 hmac 재검증 → `/admin` 직행. 테스트 설치 한도 같은 것이 없다.

### 5.3 시나리오 C — 후기 등록 (핵심)

1. `/admin`에서 상품 선택 + 샘플 엑셀(`/sample-reviews.xlsx`) 업로드
2. **미리보기** → 파싱 건수 확인
3. **옮기기** → `written` 수 증가
4. **통과 기준**: 메이크샵 관리자 → 상품 → 해당 상품 상세 후기 탭에 등록 확인.
   작성자명이 `****` 마스킹돼 있고 별점이 들어가 있는지 확인.

### 5.4 시나리오 D — 무료 20건 소진

1. 20건 초과 업로드 → 402 + `quotaExceeded`
2. DB `makeshop_usage.written`으로 사용량 확인

### 5.5 시나리오 E — 무료체험 기간(만료) enforcement

1. 설치 직후 `/api/billing` → `subscription.status = trial`, `expiredAt` = 설치일 + 14일(개발자센터 설정과 일치)
2. DB에서 `makeshop_subscription.expired_at`을 과거로 강제 변경 (또는 실제 기간 경과):
   ```sql
   update makeshop_subscription set expired_at = now() - interval '1 day', updated_at = now() - interval '1 day'
   where shop_uid = '<test shop_uid>';
   ```
3. 후기 업로드 시도 → **402 + `paywall:true`** — 결제 안내 화면 표시
4. ✅ 앱 자체 20건 카운터는 무료체험 기간 안에서만 동작 (trial 상태에서 20건 초과 → 402)

### 5.6 시나리오 F — 결제 → 콜백 201 → 만료일 갱신 (심사 핵심)

1. 402 paywall 상태에서 `/admin`의 **결제하고 계속 이용하기** 클릭
   (또는 `curl -X POST /api/billing/payment -H 'Content-Type: application/json' -d '{"payment_method":"CARD"}'`)
2. **통과 기준**:
   - 응답 `status: "paid"`, `expiredAt` = 오늘 + 30일
   - 화면에 **"결제 콜백 전송 완료 · HTTP 201 (메이크샵 수신 성공)"** 표시
   - `/admin`의 **결제/환불 콜백 이력** 카드에 `결제 … callback 201` 행 추가 (심사 캡처용)
   - 로컬 `makeshop_billing.callback_status = 201`
   - `GET /api/application/{shop_uid}/apps`의 `expired_at`이 새 만료일로 덮어써짐
   - 후기 업로드가 다시 동작 (paid = 횟수 제한 없음)
3. 파트너센터 어드민 > 판매관리 > 주문 내역에 결제 건 표시 (callback 연동 확인)

### 5.7 시나리오 G — 환불 → 콜백 201 → 즉시 차단

1. 유료 상태(`paid`)에서 `/admin`의 **환불 처리 (데모 — 콜백 연동 확인용)** 클릭
   (또는 `curl -X POST /api/billing/refund -H 'Content-Type: application/json' `
   `-d '{"payment_method":"CARD","refund_reason":"더 이상 사용하지 않습니다."}'`)
2. **통과 기준**:
   - 응답 `status: "expired"`
   - 화면에 **"환불 콜백 전송 완료 · HTTP 201"** 표시, `/admin` 이력 카드에 `환불 … callback 201` 행 추가
   - refund 콜백 **HTTP 201**, `expired_at` = 오늘(즉시 만료)
   - 파트너센터 어드민 > 판매관리 > 환불 내역에 환불 건 표시
   - 후기 업로드 → 402 paywall (환불 후 재사용 불가)
3. 환불 후 재결제하면 시나리오 F와 동일하게 복구된다 (F→G→F 데모 루프로 두 콜백을 모두 입증)

---

## 6. 알려진 함정

| # | 함정 | 증상 | 해결 |
|---|---|---|---|
| 1 | **접근 허용 IP 미등록** | 토큰 발급은 되는데 API가 403/401 | 개발정보 관리에 Vercel IP 등록 |
| 2 | 토큰 rate limit(1분 5회) | 발급 실패 | `getValidToken`이 DB 캐시(5분)로 재사용 — 최초 1회만 발급 |
| 3 | 카페24 코드 재사용 | hmac 불일치 401 | 메이크샵은 `shop_uid:ts:action` + hex + ±5분(ms) |
| 4 | timestamp 초 단위로 서명 | 401 | **밀리초**여야 한다 (`Date.now()`) |
| 5 | `review/store` 배치로 보냄 | 400 | **1건/호출**이다 |
| 6 | reg_date 형식 오류 | 등록 실패 | `YYYY-MM-DD HH:mm:ss` |
| 7 | score_1만 별점 노출인지 미확정 | 별점 안 보일 수 있음 | 첫 실측으로 확정 |

---

## 7. 심사 재요청 전 체크리스트 (무료앱 → 유료앱 전환)

- [ ] 접근 허용 IP에 Vercel egress IP 등록 (운영 필수)
- [ ] 파트너센터 판매 정보: 결제 방식 **유료 — 파트너 결제** + **무료체험 14일** + 가격(월 9,900원) 설정
- [ ] 시나리오 A (설치 완주) 통과 — 상품 목록 표시
- [ ] 시나리오 C (후기 등록) 통과 — 관리자 화면에서 확인
- [ ] 시나리오 E (무료체험 만료 → 402 paywall) 통과
- [ ] 시나리오 F (결제 → 콜백 201 → 만료일 갱신) 통과 — **심사 승인 조건** ✅ 2026-08-31 실측 통과 (`scripts/run-callback-demo.mjs`)
- [ ] 시나리오 G (환불 → 콜백 201 → 즉시 차단) 통과 ✅ 2026-08-31 실측 통과
- [ ] 진단 라우트(`/api/diag/*`) 제거 ✅ 2026-08-31 제거
- [ ] `SUBMIT.md` 갱신, 변경 커밋 + push
