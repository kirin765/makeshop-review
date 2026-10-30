'use client';

import { useEffect, useState } from 'react';

const OPTIONS = [
  { value: 'makeshop-store-search', label: '메이크샵 앱스토어·검색' },
  { value: 'other-free-app', label: '다른 무료 앱' },
  { value: 'blog-community', label: '블로그·커뮤니티' },
  { value: 'referral', label: '지인 추천' },
  { value: 'other', label: '기타' },
] as const;

type State = 'checking' | 'asking' | 'saving' | 'error' | 'done';

/**
 * 이관 성공 후 1회 표시하는 선택적 유입 경로 질문.
 * 응답은 자기신고 기록으로만 저장하며 결제 원장·사용량과 연결하지 않는다.
 * 질문이 보이지 않거나 저장에 실패해도 이관·결제·다시 시도·고객지원 흐름은 그대로다.
 */
export default function SourceSurvey({
  shopUid,
  fetcher = fetch,
}: {
  shopUid: string;
  fetcher?: typeof fetch;
}) {
  const shownKey = `mshop-source-survey:${shopUid}`;
  const [state, setState] = useState<State>(() => {
    // 이 화면은 성공 결과 뒤에만 렌더되므로 SSR 중에는 실행되지 않는다.
    try {
      return sessionStorage.getItem(shownKey) === '1' ? 'done' : 'checking';
    } catch {
      return 'checking';
    }
  });

  useEffect(() => {
    if (state !== 'checking') return;
    let cancelled = false;
    fetcher('/api/source-survey', { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        const data = response.ok ? await response.json().catch(() => ({})) : {};
        if (data.answered) {
          setState('done');
          return;
        }
        try {
          sessionStorage.setItem(shownKey, '1');
        } catch {}
        setState('asking');
      })
      .catch(() => {
        if (!cancelled) setState('done');
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher, shownKey, state]);

  if (state === 'checking' || state === 'done') return null;

  const choose = async (source: string) => {
    setState('saving');
    try {
      const response = await fetcher('/api/source-survey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      if (!response.ok) throw new Error('save failed');
      setState('done');
    } catch {
      setState('error');
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-800">
      <p className="text-sm font-medium dark:text-neutral-100">리뷰이사를 어디에서 알게 되셨나요?</p>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        선택 사항입니다. 답하지 않아도 이관·결제에 영향이 없고, 남겨주신 답은 참고용 자기신고
        기록으로만 저장됩니다.
      </p>
      <div role="group" aria-label="리뷰이사 유입 경로" className="mt-2 flex flex-wrap gap-2">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={state === 'saving'}
            onClick={() => void choose(option.value)}
            className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
          >
            {option.label}
          </button>
        ))}
        <button
          type="button"
          disabled={state === 'saving'}
          onClick={() => void choose('skipped')}
          className="rounded-lg px-3 py-1.5 text-xs text-neutral-500 underline-offset-4 hover:underline disabled:opacity-50 dark:text-neutral-400"
        >
          건너뛰기
        </button>
      </div>
      {state === 'error' ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          답을 저장하지 못했습니다. 다시 선택해 주세요.
        </p>
      ) : null}
    </div>
  );
}
