import { reviewPolicyFields, reviewPolicySources, reviewPolicyTemplate, reviewPolicyPlatformGuidance } from '@/lib/reviewPolicy';

export default function ReviewPolicyGuide() {
  return (
    <div className="space-y-4 text-pretty text-sm leading-7 text-neutral-700 dark:text-neutral-300">
      <p><strong>2026년 10월 22일부터 후기 운영 정보공개 의무가 본격 적용됩니다.</strong> 쇼핑몰 운영자는 아래 네 가지를 실제 운영 방식에 맞게 공개해야 합니다. 카페24·메이크샵 등 플랫폼에 관계없이 확인해 주세요.</p>
      <p>리뷰이사는 기본 후기 게시판으로 리뷰를 옮깁니다. 이 안내는 관리자용이며, <strong>리뷰를 이관하거나 이 도움말을 읽는 것만으로 쇼핑몰에 정책이 게시되지는 않습니다.</strong></p>
      <dl className="space-y-3">
        {reviewPolicyFields.map(([title, description]) => (
          <div key={title}><dt className="font-semibold">{title}</dt><dd className="mt-1">{description}</dd></div>
        ))}
      </dl>
      <h3 className="text-balance font-semibold">어디에 게시하나요?</h3>
      <p>상품 상세의 후기 영역과 전체 후기·포토 후기 게시판 등, 소비자가 후기 내용을 처음 확인하는 화면에 공개하세요. 공간이 부족하면 첫 화면에서 바로 열리는 ‘후기 운영 정책’ 링크나 팝업으로 연결하세요. 이용약관·개인정보처리방침에만 넣거나 화면 맨 아래에 작은 글씨로 두는 것으로는 충분하지 않습니다.</p>
      <p>{reviewPolicyPlatformGuidance}</p>
      <p>게시 후 PC와 모바일의 실제 후기 화면에서 정책을 찾고 열 수 있는지 확인하세요. 다른 리뷰 서비스를 쓰면 해당 업체에 공개 방법을 확인하세요.</p>
      <h3 className="text-balance font-semibold">외부 구매평과 삭제 처리도 확인하세요</h3>
      <p>외부 판매처에서 받은 구매평이 포함된다면 이관 사실과 대상을 정책에 설명하는 것을 권장합니다. 실제로 확인하지 않은 구매를 자사몰 구매 인증으로 안내하지 마세요. 원문·평점·협찬 표시 등 원래 정보를 임의로 바꾸지 말고, 재게시 권한과 판매처 정책도 확인하세요.</p>
      <p>삭제·숨김·비공개 처리 시 작성자에게 사유와 이의제기 방법·처리 기한을 안내하는 절차를 점검하세요. 리뷰이사는 작성자 통지나 이의접수를 자동 처리하지 않습니다. 외부 구매평 원작성자에게 연락할 수 없는 경우의 처리 방법은 공식 문답서나 관계기관에 확인하세요.</p>
      <h3 className="text-balance font-semibold">수정해서 사용할 정책 예시</h3>
      <p>아래 내용을 복사해 대괄호를 실제 운영 기준으로 바꾸고, 쇼핑몰 후기 화면에 게시하세요. 해당 사항이 없는 항목도 그 사실을 적으세요. 이 예시만으로 법적 요건 충족을 보장하지 않습니다.</p>
      <pre className="whitespace-pre-wrap break-words rounded-lg border border-neutral-200 bg-neutral-50 p-4 font-sans text-sm leading-7 dark:border-neutral-700 dark:bg-neutral-950">{reviewPolicyTemplate}</pre>
      <p>이의제기 연락처는 쇼핑몰 고객센터를 기재하세요. 리뷰이사 앱 지원 연락처와는 다릅니다.</p>
      <h3 className="text-balance font-semibold">공식 근거 · 안내 확인일 2026-10-21</h3>
      <ul className="list-disc space-y-2 pl-5">
        {reviewPolicySources.map(([title, href]) => <li key={href}><a href={href} target="_blank" rel="noreferrer" className="rounded underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">{title}<span className="sr-only"> (새 탭에서 열림)</span></a></li>)}
      </ul>
    </div>
  );
}
