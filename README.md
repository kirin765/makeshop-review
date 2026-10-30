This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## 고객지원 챗봇 (AI)

모든 페이지 우측 하단의 채팅 버튼과 [`/support`](http://localhost:3000/support) 페이지에
고객지원 AI 챗봇이 붙어 있다.

- 엔드포인트: `POST /api/chat` — OpenRouter(OpenAI 호환) 스트리밍을 `{"text": ...}` SSE로 흘려보낸다
- 지식 베이스: [`src/lib/chat/knowledge.ts`](src/lib/chat/knowledge.ts) — 앱 소개·이용 방법·현재 상태·오류 안내를
  수정하면 프롬프트에 반영된다
- 설정: `OPENROUTER_API_KEY` 필수, `OPENROUTER_MODEL`(기본 `openai/gpt-4o-mini`) 선택
- UI: `src/components/chat/ChatPanel.tsx` + `ChatWidget.tsx`

## 테스트

- `npm test` — 파서·이관 클라이언트·자기신고 유입 경로 라우트 단위 테스트 (외부 호출 없음)
- `npm run test:db` — 일회용 PostgreSQL 17(Docker)에서 원장·클레임·쿼터·유입 경로 통합 테스트
- `npm run test:e2e` — 일회용 PostgreSQL + 메이크샵 API mock + 프로덕션 빌드 + Chromium으로
  설치 진입부터 이관·원장 삭제·결제/환불 콜백·모바일 레이아웃까지 확인한다. 실제 고객 데이터나
  실제 메이크샵 API는 쓰지 않는다. Docker와 Chromium, Playwright가 필요하며
  `PLAYWRIGHT_MODULE_PATH`·`CHROMIUM_EXECUTABLE`로 위치를 지정할 수 있다.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
