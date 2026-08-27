import { NextRequest, NextResponse } from 'next/server';
import { verifyLaunch, sessionCookie } from '@/lib/launch';
import { getValidToken } from '@/lib/token';
import { getSubscription } from '@/lib/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 메이크샵 앱 실행 진입점 — 개발정보 관리의 APP URL이 이 주소를 가리킨다.
 * 설치(install)·재접속 모두 동일하게 APP URL로 `?shop_uid=&timestamp=&action_type=&hmac=`
 * 를 GET으로 보내온다 (docs/guide/app/install). hmac 검증이 곧 인증이고 OAuth가 없다.
 *
 * - hmac 검증 통과 → 세션 쿠키 발급 → /admin
 * - 실패 → 401 (재시도 스톰 방지용 안내)
 */
export async function GET(req: NextRequest) {
  const launch = verifyLaunch(req.nextUrl.searchParams);
  if (!launch) {
    return NextResponse.json({ error: 'invalid launch request' }, { status: 401 });
  }

  // 토큰이 없거나 만료 임박이면 지금 재발급해 둔다 — 첫 화면(상품 목록)이 바로 열리게.
  await getValidToken(launch.shopUid);
  // 무료체험 만료일(설치일 + 무료체험 기간)을 메이크샵 설치 정보에서 읽어 캐시한다.
  // 실패해도 (getSubscription의 폴백) 설치는 막지 않는다.
  await getSubscription(launch.shopUid).catch(() => {});

  const res = NextResponse.redirect(new URL('/admin', req.url));
  res.cookies.set(sessionCookie(launch.shopUid));
  return res;
}
