# 심사 제출 체크리스트 — 유료앱(파트너 결제) 재신청

> 마감 **2026-09-15**. 이 날까지 심사 제출 못 하면 KILL (원장 게이트).
>
> ## 반려 사유 → 재신청 방향 (2026-08-27 회신)
>
> 메이크샵 파트너센터가 **무료앱 신청 건을 반려**하며 아래를 요구했다.
>
> 1. **무료체험은 기간 기준** — 무료 이용 건수(20건)는 귀사 정책으로 유지하되,
>    파트너센터에는 **무료체험 기간을 설정한 유료앱**으로 신청할 것.
> 2. **유료앱 수익쉐어 20%** — 결제/환불 콜백 API 연동이 심사 필수
>    (결제/환불 API 가이드 · 심사 기준, developer.makeshop.co.kr).
>
> 이에 따라: **결제 방식 = 유료 — 파트너 결제**, 무료체험 = **14일(기간)**,
> 앱 자체 무료 건수 정책(체험 중 20건)은 유지, 결제/환불 콜백 API 연동 완료 후 재심사.

## 결제/환불 콜백 연동 — 코드 완료 (docs/guide/app/orders-callback-api 실측)

| 항목 | 값 |
|---|---|
| 결제 완료 전달 | `POST /api/application/{shop_uid}/callback/payment` — 201 |
| 환불 완료 전달 | `POST /api/application/{shop_uid}/callback/refund` — 201 |
| body | `client_id`, `partner_order_uid`, `amount`, `payment_method`, `expired_at`(YYYYMMDD, 만료일 강제 덮어쓰기) |
| payment_method | `CARD`·`TRANSFER`·`VIRTUAL_ACCOUNT`·`PHONE`·`FREE` |
| 액세스 토큰 | client_credentials 토큰 (client_id·shop_uid 동일해야 조회 가능) |

- 구현: `src/lib/billing.ts` (구독 상태 + 결제/환불 기록), `src/lib/makeshop.ts` (`notifyPayment`·`notifyRefund`)
- 엔드포인트: `POST /api/billing/payment` · `POST /api/billing/refund` (MAKESHOP_BILLING_KEY 미설정 시 상점 세션 허용 → 앱 안 "결제하기"로 콜백 연동 데모 가능, 설정 시 PG 웹훅 전용)
- **무료체험(기간) enforcement는 우리 몫** — `src/lib/quota.ts`가 만료 시 402(paywall)로 차단

## 코드 쪽 — 완료

| 항목 | 상태 |
|---|---|
| hmac 설치 검증 | ✅ `{shop_uid}:{timestamp}:{action_type}` hex, ±5분(ms) |
| 세션 발급 (서명 쿠키) | ✅ `mshop_sess` |
| 토큰 발급·캐시 | ✅ client_credentials + DB 캐시(5분·rate limit 회피) |
| 상품 조회 | ✅ `fields=uid,product_name`, 페이지네이션 |
| 후기 등록 | ✅ `/review/store` 1건/호출, 마스킹, reg_date |
| 엑셀 파싱·마스킹 | ✅ 스마트스토어·쿠팡 |
| **무료체험 14일(기간 기준)** | ✅ 설치 시 `GET /api/application/{shop_uid}/apps`의 `expired_at` 캐시, 만료 시 402 paywall |
| **체험 중 무료 20건** | ✅ 귀사 정책 유지 — trial 상태에서 20건 카운터 |
| **결제 콜백 연동** | ✅ `/api/billing/payment` → payment 콜백 201 → 만료일 갱신 |
| **환불 콜백 연동** | ✅ `/api/billing/refund` → refund 콜백 201 → 만료일=오늘(즉시 차단) |
| 개인정보처리방침 | ✅ `/privacy` |

## 개발자센터에서 채울 것 — 사용자

### STEP 01 파트너센터 가입 + 파트너 등록
1. partner.makeshop.co.kr → 파트너 등록 (파트너 심사 승인 필요)
2. 개발은 **파트너 승인 전에도 가능** (공식 문서: 심사 요청·스토어 출시만 승인 후)

### STEP 02 새 APP 만들기 + 개발 정보 관리
1. 상품 > App > **새 APP 만들기**
2. **기본 정보**
   - 상품명: **리뷰이사**
   - APP URL: `https://<prod>/`
   - URL 표시 방식: 새 창 열기
   - **접근 허용 IP**: Vercel egress IP 등록 🔴 (없으면 API가 안 열린다)
3. **API 권한 설정 (Scope)** — 기능에 실제 필요한 것만:
   - **상품 (read)**
   - **게시판 (read/write)** — 후기 등록
   - **결제 (read/write)** — 결제/환불 콜백에 필요 (조회 시 확인)
   - 불필요한 권한 요청은 심사 반려 사유가 된다 (공식 문서)
4. **인증 정보**: Client ID / Client Secret Key 복사 → `.env`의 `MAKESHOP_CLIENT_ID`/`MAKESHOP_CLIENT_SECRET`

### STEP 03 테스트 실행
- 상품 > App > 개발정보 관리 > 하단 **테스트 실행** → TEST-GUIDE.md 시나리오 A·C·E·F·G로 검증

### STEP 04 판매 정보 관리 — 🔴 무료 → **유료 — 파트너 결제**로 변경
| 항목 | 넣을 값 |
|---|---|
| 앱 이름 | **리뷰이사** |
| 카테고리 | 리뷰 |
| 결제 방식 | **유료 — 파트너 결제** (본인 결제 시스템 사용 · 메이크샵 사전 협의 = 반려 메일로 진행됨) |
| **무료체험 기간** | **14일** (`src/lib/billing.ts`의 `TRIAL_DAYS=14`와 일치) |
| 가격 (결제 주기) | **월 9,900원 / 30일** (`PLAN`과 일치) |
| 환불 정보 | 환불 가능 — 파트너 직접 처리 후 refund 콜백 (docs/guide/app/refunds) |
| 한 줄 소개 | 스마트스토어·쿠팡 구매평을 메이크샵 상품 후기로. 엑셀 한 번이면 끝. (무료체험 14일) |
| 상세 설명 | 아래 초안 참조 — "무료체험 14일, 이후 월 9,900원" 문구 포함 |
| 상품 상세 이미지 | 🔴 기존 `public/store/detail-0X.png`에 "무료" 문구 있음 — `store-assets/detail-images.html` 수정본(무료체험 14일·월 9,900원)으로 **이미지 재생성 후 재업로드** |

### STEP 05 심사 요청
- 심사 상태: 제작중 → 심사중 → 심사완료
- 🔴 결제 방식이 유료 — 파트너 결제이므로 **콜백 API 연동 확인이 심사 승인 조건** (심사 기준 참조).
  TEST-GUIDE 시나리오 F(결제)·G(환불)를 테스트 몰에서 통과시킨 뒤 신청.

### ✅ 심사 제출 이력
- **2026-08-13**: 무료앱으로 최초 제출 — 상태 심사중
- **2026-08-27**: 반려 (무료체험 기간 기준 · 콜백 API 연동 요구) → 유료앱 전환 작업 완료 → 재신청 대기

## 심사 통과 후

- [ ] 심사 결과 대기
- [ ] 통과 시 **스토어 노출 설정**에서 노출 켜기 (미설정 시 미노출)
- [ ] 라이브 후 설치 수 실측 — 게이트 분모
- [ ] `MAKESHOP_BILLING_KEY` 설정 + PG(결제대행) 웹훅 연동 (심사 데모 모드 → 운영 모드 전환)

## 미확인

| # | 항목 |
|---|---|
| 1 | 메이크샵 심사 소요 기간 |
| 2 | 접근 허용 IP 갱신 — Vercel egress IP가 바뀌는지 (서버리스라 변경 시마다 재등록?) |
| 3 | 후기 `score_1` 별점 노출 확인 (상품 상세에서 실제 렌더 확인 필요) |
| 4 | 결제/환불 콜백의 `expired_at` 덮어쓰기 실측 — 테스트 몰에서 callback 201 후 `GET apps` expired_at 변경 확인 |
| 5 | 파트너센터 판매 정보에 "무료체험 기간" 입력 항목의 정확한 위치/형식 |