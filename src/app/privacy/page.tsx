export const metadata = { title: '개인정보처리방침 — 리뷰이사' };

export default function Privacy() {
  return (
    <main className="mx-auto max-w-2xl p-8 text-sm leading-7">
      <h1 className="text-lg font-semibold">개인정보처리방침</h1>
      <p className="mt-1 text-xs text-neutral-500">최종 수정 2026-10-30</p>

      <h2 className="mt-6 font-medium">1. 수집하는 정보</h2>
      <ul className="mt-1 list-disc pl-5">
        <li>쇼핑몰 식별자(shop_uid)와 메이크샵 API 접근 토큰(서버 내 캐시)</li>
        <li>이용자가 업로드한 구매평의 <b>내용·평점·작성일·옵션</b></li>
        <li>작성자 표기는 <b>마스킹된 형태로만</b> 저장합니다 (예: <code>cher****</code>)</li>
        <li>이관 성공 후 <b>선택적으로</b> 응답한 유입 경로(자기신고, 건너뛰기 포함)</li>
      </ul>

      <h2 className="mt-6 font-medium">2. 수집하지 않는 정보</h2>
      <p>구매자의 실명·연락처·주소·주문번호는 수집하지 않습니다. 업로드 파일에 포함돼 있어도 저장하지 않습니다.</p>

      <h2 className="mt-6 font-medium">3. 이용 목적</h2>
      <p>업로드한 구매평을 이용자 본인의 메이크샵 쇼핑몰 상품 후기로 옮기는 목적으로 사용합니다. 선택적으로 응답한 유입 경로는 서비스 개선을 위한 참고 자료로만 사용하며, 유료 판정이나 결제와 연결하지 않습니다.</p>

      <h2 className="mt-6 font-medium">4. 보관 및 파기</h2>
      <p>접근 토큰은 5분 유효로 만료 후 재발급됩니다. 업로드 파일은 처리 후 서버에 남기지 않습니다. 유입 경로 응답은 상점당 1건만 보관하며, 삭제를 원하시면 아래 문의처로 요청해 주세요.</p>

      <h2 className="mt-6 font-medium">5. 제3자 제공</h2>
      <p>제3자에게 제공하지 않습니다.</p>

      <h2 className="mt-6 font-medium">6. 문의</h2>
      <p>kwan765@naver.com</p>
    </main>
  );
}
