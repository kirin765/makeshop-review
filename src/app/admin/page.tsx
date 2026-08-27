'use client';

import { useEffect, useState } from 'react';

type Product = { no: string; name: string };
type Quota = {
  used: number;
  limit: number;
  paid: boolean;
  status?: 'trial' | 'paid' | 'expired';
  expiredAt?: string;
  daysLeft?: number;
  trialDays?: number;
  paywall?: boolean;
  plan?: { name: string; price: number; termDays: number };
};
type Result = {
  dryRun?: boolean;
  count?: number;
  sample?: { writer: string; content: string; option?: string; score?: number; createdAt?: string | null }[];
  parsed?: number;
  written?: number;
  skipped?: number;
  freeRemaining?: number | null;
  paid?: boolean;
  quotaExceeded?: boolean;
  paywall?: boolean;
  expiredAt?: string;
  used?: number;
  error?: string;
  headers?: string[];
};

function kstDate(iso: string): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** 구독 상태 카드 — 무료체험(기간) / 유료 / 만료(페이월+결제하기) */
function SubscriptionCard({ quota, onPay }: { quota: Quota; onPay: () => void }) {
  const status = quota.status ?? (quota.paid ? 'paid' : 'trial');
  const price = quota.plan?.price ?? 9900;
  const termDays = quota.plan?.termDays ?? 30;
  const used = Math.min(quota.used, FREE_LIMIT);

  if (status === 'expired') {
    return (
      <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
        <p className="text-sm font-semibold text-red-700">무료체험 기간이 끝났어요.</p>
        <p className="mt-1 text-xs text-neutral-600">결제하면 바로 다시 이용할 수 있어요.</p>
        <p className="mt-2 text-xs text-neutral-500">
          {quota.plan?.name ?? '리뷰이사 유료 플랜'} · 월 {price.toLocaleString()}원 · 이용 기간 {termDays}일
        </p>
        <button
          onClick={onPay}
          className="mt-3 rounded bg-black px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
        >
          결제하고 계속 이용하기
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-neutral-300 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          {status === 'paid' ? '유료 이용 중' : `무료체험 중 · D-${quota.daysLeft ?? 0}`}
        </p>
        <span className="text-[11px] text-neutral-500">만료일 {kstDate(quota.expiredAt ?? '')}</span>
      </div>
      {status === 'trial' && (
        <>
          <div className="mt-3 h-1.5 w-full rounded-full bg-neutral-100">
            <div className="h-1.5 rounded-full bg-black transition-all" style={{ width: `${Math.min(100, Math.round((used / FREE_LIMIT) * 100))}%` }} />
          </div>
          <p className="mt-1 text-[11px] text-neutral-500">무료체험 중 {FREE_LIMIT}건까지 · {used}건 사용</p>
          <p className="mt-2 text-[11px] text-neutral-500">
            무료체험 종료 후 월 {price.toLocaleString()}원으로 계속 사용할 수 있어요.
          </p>
        </>
      )}
      {status === 'paid' && (
        <p className="mt-2 text-[11px] text-neutral-500">횟수 제한 없이 이용할 수 있어요. 결제·환불 문의: kwan765@naver.com</p>
      )}
    </div>
  );
}

const FREE_LIMIT = 20;

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [shopUid, setShopUid] = useState('');
  const [quota, setQuota] = useState<Quota | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productNo, setProductNo] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    fetch('/api/products')
      .then((r) => r.json())
      .then((d) => {
        if (d.shopUid) setShopUid(d.shopUid);
        if (d.quota) setQuota(d.quota);
        if (Array.isArray(d.products)) setProducts(d.products);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function refreshQuota() {
    fetch('/api/products')
      .then((r) => r.json())
      .then((d) => {
        if (d.quota) setQuota(d.quota);
      })
      .catch(() => {});
  }

  async function pay() {
    setPaying(true);
    setResult(null);
    try {
      const res = await fetch('/api/billing/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_method: 'CARD' }),
      });
      const json = await res.json();
      if (res.ok) {
        setResult({ written: 0, paid: true, freeRemaining: null });
        refreshQuota();
      } else {
        setResult({ error: json.error ?? '결제 처리에 실패했습니다.' });
      }
    } catch {
      setResult({ error: '결제 처리에 실패했습니다.' });
    } finally {
      setPaying(false);
    }
  }

  async function run(dry: boolean) {
    if (!file || !productNo) return;
    setBusy(true);
    setResult(null);
    const fd = new FormData();
    fd.set('product_no', productNo);
    fd.set('file', file);
    if (dry) fd.set('dry_run', '1');
    const res = await fetch('/api/reviews', { method: 'POST', body: fd });
    const json = await res.json();
    if (res.status === 402) {
      setResult({ quotaExceeded: true, paywall: json.paywall, expiredAt: json.expiredAt, used: json.used });
      refreshQuota();
    } else {
      setResult(json);
      if (!dry && typeof json.freeRemaining === 'number')
        setQuota((q) => (q ? { ...q, used: q.limit - json.freeRemaining } : q));
    }
    setBusy(false);
  }

  async function useSample() {
    const blob = await fetch('/sample-reviews.xlsx').then((r) => r.blob());
    setFile(new File([blob], 'sample-reviews.xlsx', { type: blob.type }));
    setResult(null);
  }

  if (loading)
    return <main className="p-8 text-sm text-neutral-500">몰 정보를 불러오는 중입니다…</main>;

  if (!shopUid)
    return <main className="p-8 text-sm">메이크샵 관리자에서 앱을 실행해 주세요.</main>;

  return (
    <main className="mx-auto max-w-2xl p-6 font-sans">
      <h1 className="text-lg font-semibold">리뷰 옮기기</h1>
      <p className="mt-1 text-xs text-neutral-500">shop_uid: {shopUid}</p>

      {quota && <SubscriptionCard quota={quota} onPay={pay} />}

      {quota?.status === 'expired' ? (
        <div className="mt-6 rounded border border-neutral-200 bg-neutral-50 p-6 text-center text-sm text-neutral-600">
          <p className="font-medium">무료체험 기간이 끝나 결제가 필요합니다.</p>
          <p className="mt-1 text-xs text-neutral-500">
            결제를 완료하면 리뷰 옮기기를 계속 사용할 수 있어요. (문의: kwan765@naver.com)
          </p>
        </div>
      ) : (
        <>
          <ol className="mt-6 space-y-5 text-sm">
            <li>
              <div className="font-medium">1. 리뷰 엑셀을 준비하세요</div>
              <div className="mt-1 text-neutral-600">
                <span className="font-medium text-neutral-700">스마트스토어</span> — 판매자센터 → 리뷰
                관리 → 구매평 엑셀 다운로드
              </div>
              <div className="mt-1 text-neutral-600">
                <span className="font-medium text-neutral-700">쿠팡</span> — 윙 → 문의/리뷰 → 리뷰
                목록에서 표를 복사해{' '}
                <a href="/coupang-review-template.xlsx" className="underline">쿠팡 템플릿</a>
                에 붙여넣기
              </div>
            </li>

            <li>
              <div className="font-medium">2. 어느 상품에 넣을지 고르세요</div>
              <select
                className="mt-2 w-full rounded border p-2"
                value={productNo}
                onChange={(e) => setProductNo(e.target.value)}
              >
                <option value="">상품 선택</option>
                {products.map((p) => (
                  <option key={p.no} value={p.no}>
                    [{p.no}] {p.name}
                  </option>
                ))}
              </select>
              {products.length === 0 && (
                <p className="mt-1 text-xs text-neutral-500">상품이 없으면 메이크샵 관리자에서 상품을 먼저 등록해 주세요.</p>
              )}
            </li>

            <li>
              <div className="font-medium">3. 엑셀 파일을 올리세요</div>
              <label className="mt-2 inline-block cursor-pointer rounded border px-4 py-2 text-sm hover:bg-neutral-50">
                파일 선택
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <div className="mt-2 text-xs text-neutral-500">
                엑셀이 아직 없다면{' '}
                <button onClick={useSample} className="underline">샘플 엑셀로 체험하기</button>
                {' · '}
                <a href="/sample-reviews.xlsx" className="underline">샘플 내려받기</a>
              </div>
              {file && <div className="mt-1 text-xs text-neutral-600">선택된 파일: {file.name}</div>}
            </li>
          </ol>

          <div className="mt-6 flex gap-2">
            <button
              onClick={() => run(true)}
              disabled={busy || !file || !productNo}
              className="rounded border px-4 py-2 text-sm disabled:opacity-40"
            >
              미리보기
            </button>
            <button
              onClick={() => run(false)}
              disabled={busy || !file || !productNo}
              className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
            >
              {busy ? '옮기는 중…' : '옮기기'}
            </button>
          </div>

          <p className="mt-8 border-t pt-4 text-xs text-neutral-500">
            {quota?.status === 'paid'
              ? '유료 플랜 — 횟수 제한 없이 이용할 수 있어요.'
              : '무료체험 기간 동안 20건까지 옮겨볼 수 있어요.'}{' '}
            · <a href="/privacy" className="underline">개인정보처리방침</a>
          </p>
        </>
      )}

      {result && (
        <div className="mt-6 rounded bg-neutral-50 p-4 text-sm">
          {result.quotaExceeded ? (
            result.paywall ? (
              <div>
                <p className="font-medium text-red-700">무료체험 기간이 끝났습니다.</p>
                <p className="mt-1 text-xs text-neutral-600">결제 후 계속 이용할 수 있습니다.</p>
                <button
                  onClick={pay}
                  disabled={paying}
                  className="mt-3 rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
                >
                  {paying ? '결제 처리 중…' : '결제하고 계속 이용하기'}
                </button>
              </div>
            ) : (
              <SubscriptionCard quota={{ ...quota!, paywall: false }} onPay={pay} />
            )
          ) : result.error ? (
            <p className="text-red-600">
              {result.parsed === 0
                ? '엑셀을 읽지 못했습니다. 구매평 엑셀 파일이 맞는지 확인해 주세요.'
                : '옮기는 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.'}
              <span className="mt-1 block text-xs text-neutral-500">{result.error}</span>
            </p>
          ) : result.dryRun ? (
            <>
              <p className="font-medium">구매평 {result.count}건을 읽었습니다. 아래는 앞 3건입니다.</p>
              <ul className="mt-2 space-y-2 text-xs text-neutral-700">
                {result.sample?.map((s, i) => (
                  <li key={i} className="rounded border bg-white p-2">
                    <span className="font-medium">{s.writer}</span>
                    {s.score ? <span className="text-amber-500"> ★{s.score}</span> : null}
                    {s.createdAt && <span className="text-neutral-400"> {s.createdAt}</span>}
                    {' — '}{s.content}
                    {s.option && <span className="text-neutral-500"> [옵션] {s.option}</span>}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-neutral-500">아직 아무것도 등록되지 않았습니다. 「옮기기」를 누르면 실제로 등록됩니다.</p>
            </>
          ) : (
            <>
              <p className="font-medium">
                {result.paid
                  ? '결제가 완료되었습니다. 리뷰 옮기기를 계속 사용할 수 있어요.'
                  : `구매평 ${result.written}건을 옮겼습니다.`}
              </p>
              {(result.skipped ?? 0) > 0 && (
                <p className="mt-1 text-xs text-neutral-500">(건너뜀 {result.skipped}건)</p>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}