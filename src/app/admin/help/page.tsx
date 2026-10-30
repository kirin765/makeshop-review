import Link from 'next/link';
import ReviewPolicyGuide from '@/components/ReviewPolicyGuide';

export const metadata = { title: '후기 운영 정책 공개 안내 — 리뷰이사' };

export default function HelpPage() {
  return (
    <main className="min-h-dvh bg-neutral-50 px-4 py-8 text-neutral-900 sm:px-6 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <Link href="/admin" className="rounded text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">리뷰 관리로 돌아가기</Link>
        <section id="review-policy" aria-labelledby="policy-title" className="mt-6 scroll-mt-6 rounded-xl border border-neutral-200 bg-white p-5 sm:p-8 dark:border-neutral-800 dark:bg-neutral-900">
          <h1 id="policy-title" className="mb-4 text-balance text-2xl font-semibold">후기 운영 정책 공개 안내</h1>
          <ReviewPolicyGuide />
        </section>
      </div>
    </main>
  );
}
