import { redirect } from 'next/navigation';
import { sessionShop } from '@/lib/launch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 메이크샵 설치 진입점. 개발정보 관리의 APP URL을 이 루트로 지정한다.
 * 메이크샵이 설치/재접속 시 `?shop_uid=&timestamp=&action_type=&hmac=`를 붙여 이 주소를 연다.
 * hmac이 있으면 /api/auth/launch로 보내고(검증+세션 발급), 세션이 이미 있으면 /admin으로 보낸다.
 */
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;

  if (sp.shop_uid && sp.hmac) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (typeof v === 'string') q.set(k, v);
    }
    redirect(`/api/auth/launch?${q.toString()}`);
  }

  const shopUid = await sessionShop();
  if (shopUid) redirect('/admin');

  return (
    <main className="mx-auto max-w-xl p-8 font-sans">
      <h1 className="text-xl font-semibold">리뷰이사</h1>
      <p className="mt-2 text-sm text-neutral-600">
        쿠팡·네이버 스마트스토어 구매평을 메이크샵 상품 후기로 한 번에 옮깁니다.
      </p>

      <div className="mt-6 rounded border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700">
        메이크샵 관리자에서 이 앱을 <b>설치</b>하면 이곳으로 연결됩니다.
      </div>

      <ul className="mt-6 space-y-2 text-sm text-neutral-700">
        <li>① 리뷰 엑셀을 준비합니다 — 판매처에서 받은 구매평 파일 그대로</li>
        <li>② 옮길 상품을 고르고 파일을 올립니다</li>
        <li>③ 미리보기로 확인한 뒤 옮기기를 누르면 메이크샵 상품 후기로 등록됩니다</li>
      </ul>

      <p className="mt-8 border-t pt-4 text-xs text-neutral-500">
        <a href="/privacy" className="underline">개인정보처리방침</a>
      </p>
    </main>
  );
}
