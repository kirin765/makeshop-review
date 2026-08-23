export const metadata = { title: '개인정보처리방침 — 리뷰이사' };

export default function Privacy() {
  return (
    <main className="mx-auto max-w-2xl p-8 text-sm leading-7">
      <h1 className="text-lg font-semibold">개인정보처리방침</h1>
      <p className="mt-1 text-xs text-neutral-500">최종 수정 2026-08-13</p>

      <h2 className="mt-6 font-medium">1. 수집하는 정보</h2>
      <ul className="mt-1 list-disc pl-5">
        <li>쇼핑몰 식별자(shop_uid)와 메이크샵 API 접근 토큰(서버 내 캐시)</li>
        <li>이용자가 업로드한 구매평의 <b>내용·평점·작성일·옵션</b></li>
        <li>작성자 표기는 <b>마스킹된 형태로만</b> 저장합니다 (예: <code>cher****</code>)</li>
      </ul>

      <h2 className="mt-6 font-medium">2. 수집하지 않는 정보</h2>
      <p>구매자의 실명·연락처·주소·주문번호는 수집하지 않습니다. 업로드 파일에 포함돼 있어도 저장하지 않습니다.</p>

      <h2 className="mt-6 font-medium">3. 이용 목적</h2>
      <p>업로드한 구매평을 이용자 본인의 메이크샵 쇼핑몰 상품 후기로 옮기는 목적으로만 사용합니다.</p>

      <h2 className="mt-6 font-medium">4. 보관 및 파기</h2>
      <p>접근 토큰은 5분 유효로 만료 후 재발급됩니다. 업로드 파일은 처리 후 서버에 남기지 않습니다.</p>

      <h2 className="mt-6 font-medium">5. 제3자 제공</h2>
      <p>제3자에게 제공하지 않습니다.</p>

      <h2 className="mt-6 font-medium">6. 문의</h2>
      <p>kwan765@naver.com</p>
    </main>
  );
}
