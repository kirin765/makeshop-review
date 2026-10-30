import Link from 'next/link';

export default function ReviewPolicyNotice() {
  return (
    <aside aria-label="후기 운영 정책 공개 안내" className="mt-6 rounded-lg border border-neutral-300 bg-neutral-50 p-4 text-sm dark:border-neutral-700 dark:bg-neutral-900">
      <h2 className="text-balance font-semibold text-neutral-900 dark:text-neutral-100">후기 운영 정책을 쇼핑몰에 공개해 주세요</h2>
      <p className="mt-2 text-pretty leading-6 text-neutral-700 dark:text-neutral-300">2026년 10월 22일부터 작성 권한·게시기간·등급평가·삭제 및 이의제기 기준의 공개 의무가 본격 적용됩니다. 옮긴 구매평도 포함해 실제 운영 기준을 확인하고, 고객이 후기를 읽는 화면에 게시하세요.</p>
      <Link href="/admin/help#review-policy" target="_blank" rel="noreferrer" className="mt-2 inline-block rounded py-1 font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">공개 위치·체크리스트·정책 예시 보기<span className="sr-only"> (새 탭에서 열림)</span></Link>
    </aside>
  );
}
