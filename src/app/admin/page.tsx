'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseReviewFile, type ImportedReview as ParsedReview } from '@/lib/reviewImport';

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
type ImportedRow = {
  import_key: string;
  product_uid: string;
  writer: string;
  score: number;
  content: string;
  created_date: string | null;
  imported_at: string;
};
type Result = {
  stage?: string;
  dryRun?: boolean;
  count?: number;
  allowed?: number;
  sample?: { writer: string; content: string; option?: string | null; score?: number; createdAt?: string | null }[];
  parsed?: number;
  written?: number;
  failed?: number;
  /** 이미 옮겨진(원장에 기록된) 리뷰로 재전송에서 건너뛴 건수 */
  already?: number;
  skipped?: number;
  freeRemaining?: number | null;
  paid?: boolean;
  /** 결제/환불 시 메이크샵 콜백 API의 HTTP 상태 — 데모에서는 201이어야 한다 (심사 확인용) */
  callbackStatus?: number;
  refunded?: boolean;
  quotaExceeded?: boolean;
  paywall?: boolean;
  expiredAt?: string;
  used?: number;
  error?: string;
  headers?: string[];
};

type BillingInfo = {
  demoMode: boolean;
  subscription: {
    status: 'trial' | 'paid' | 'expired';
    installedAt: string | null;
    expiredAt: string;
    daysLeft: number;
    unverified: boolean;
  };
  plan: { name: string; price: number; termDays: number };
  history: {
    id: number;
    kind: 'payment' | 'refund';
    partnerOrderUid: string;
    amount: number;
    paymentMethod: string;
    expiredAt: string;
    callbackStatus: number | null;
    createdAt: string;
    refundReason: string | null;
  }[];
};

function kstDate(iso: string): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** 구독 상태 카드 — 무료체험(기간) / 유료 / 만료(페이월+결제하기) */
function SubscriptionCard({
  quota,
  demoMode,
  onPay,
  onRefund,
  refunding,
}: {
  quota: Quota;
  demoMode: boolean;
  onPay: () => void;
  onRefund: () => void;
  refunding: boolean;
}) {
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
        {demoMode ? (
          <button
            onClick={onPay}
            disabled={refunding}
            className="mt-3 rounded bg-black px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-40"
          >
            결제하고 계속 이용하기
          </button>
        ) : (
          <p className="mt-2 text-xs text-neutral-500">결제·환불 문의: kwan765@naver.com (결제 완료 시 자동으로 풀립니다)</p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-neutral-300 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          {status === 'paid' ? '유료 이용 중' : `무료체험 중 · D-${Math.min(quota.daysLeft ?? 0, 999)}`}
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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-[11px] text-neutral-500">횟수 제한 없이 이용할 수 있어요. 결제·환불 문의: kwan765@naver.com</p>
          {demoMode && (
            <button
              onClick={onRefund}
              disabled={refunding}
              className="rounded border border-neutral-300 px-2 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-40"
            >
              {refunding ? '환불 처리 중…' : '환불 처리 (데모 — 콜백 연동 확인용)'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const FREE_LIMIT = 20;
const PAGE_SIZE = 50;
// 한 요청에 보내는 리뷰 수. 메이크샵 review/store는 1건/호출 + 건마다 150ms 대기라
// 50건 ≈ 15초 수준 — 서버리스 60초 안에 넉넉히 끝난다. 배치가 작을수록 요청이 끊겼을 때
// 중복될 수 있는 창도 작아진다. 서버가 내용 해시로 이미 옮긴 리뷰를 걸러내므로(멱등)
// 재전송돼도 중복 등록되지 않는다.
const IMPORT_BATCH = 50;
// 배치 요청 클라이언트 타임아웃. 서버 함수가 60초 제한에 죽거나 응답이 늦어도
// 화면이 무한 대기하지 않게 넉넉히 끊는다(끊겨도 재개 지점이 남고, 재전송은 서버가 걸러낸다).
const BATCH_FETCH_TIMEOUT_MS = 70000;
// 이어서 보낸 배치가 이만큼 연속 실패하면 이관 전체를 멈춘다(인증·시스템 오류 감지용).
const MAX_CONSEC_FAILS = 5;
// 삭제 API 한 요청당 건 수 — 서버 MAX_DELETE와 일치 (1건/호출이라 30건이 적당하다).
const DELETE_CHUNK = 30;

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [shopUid, setShopUid] = useState('');
  const [quota, setQuota] = useState<Quota | null>(null);
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productNo, setProductNo] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [importProgress, setImportProgress] = useState<{
    written: number;
    total: number;
    failed: number;
    resuming: boolean;
  } | null>(null);
  const [imports, setImports] = useState<ImportedRow[] | null>(null);
  const [importedError, setImportedError] = useState('');
  const [importedMsg, setImportedMsg] = useState('');
  const [filterProduct, setFilterProduct] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [delBusy, setDelBusy] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{ deleted: number; total: number; failed: number } | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [parsed, setParsed] = useState<ParsedReview[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/products').then((r) => r.json()),
      fetch('/api/billing').then((r) => r.json()),
    ])
      .then(([d, b]) => {
        if (d.shopUid) setShopUid(d.shopUid);
        if (d.quota) setQuota(d.quota);
        if (Array.isArray(d.products)) setProducts(d.products);
        if (b.subscription) setBilling(b);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadImports = useCallback(async (pageNum: number, productNo: string) => {
    setImportedError('');
    setImportedMsg('');
    const q = new URLSearchParams();
    if (productNo) q.set('product_no', String(productNo));
    q.set('page', String(pageNum));
    q.set('page_size', String(PAGE_SIZE));
    fetch(`/api/imports?${q}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? '목록을 불러오지 못했습니다.');
        setImports(d.reviews ?? []);
        setTotal(d.total ?? 0);
        setPage(d.page ?? 1);
      })
      .catch((e: Error) => {
        setImportedError(e.message);
        setImports([]);
        setTotal(0);
      });
  }, []);

  useEffect(() => {
    // 최초 마운트 시 1회 로드 — 로딩 상태로 시작하는 것이 의도된 동작이다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadImports(1, '');
  }, [loadImports]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function refreshQuota() {
    fetch('/api/products')
      .then((r) => r.json())
      .then((d) => {
        if (d.quota) setQuota(d.quota);
      })
      .catch(() => {});
  }

  function refreshBilling() {
    fetch('/api/billing')
      .then((r) => r.json())
      .then((d) => {
        if (d.subscription) setBilling(d);
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
        setResult({ written: 0, paid: true, freeRemaining: null, callbackStatus: json.callbackStatus });
        refreshQuota();
        refreshBilling();
      } else {
        setResult({ error: json.error ?? '결제 처리에 실패했습니다.' });
      }
    } catch {
      setResult({ error: '결제 처리에 실패했습니다.' });
    } finally {
      setPaying(false);
    }
  }

  async function refund() {
    if (!window.confirm('결제를 환불 처리하고 앱 이용을 종료합니다. 진행할까요? (메이크샵 refund 콜백을 호출합니다)')) return;
    setRefunding(true);
    setResult(null);
    try {
      const res = await fetch('/api/billing/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_method: 'CARD', refund_reason: '데모 — 환불 콜백 연동 확인' }),
      });
      const json = await res.json();
      if (res.ok) {
        setResult({ refunded: true, callbackStatus: json.callbackStatus });
        refreshQuota();
        refreshBilling();
      } else {
        setResult({ error: json.error ?? '환불 처리에 실패했습니다.' });
      }
    } catch {
      setResult({ error: '환불 처리에 실패했습니다.' });
    } finally {
      setRefunding(false);
    }
  }

  /** localStorage에 이어올 지점을 남긴다. 같은 파일·상품이면 중단 지점부터 계속한다. */
  const resumeKey = useCallback(
    (productNo: string, f: File | null) => {
      if (!f) return '';
      return `mshop-import:${shopUid}:${productNo}:${f.name}:${f.size}:${f.lastModified}`;
    },
    [shopUid],
  );
  const readResume = (key: string) => {
    try {
      const n = Number(localStorage.getItem(key) ?? 0);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch {
      // iframe·비공개 모드 등에서 저장소 접근이 거부되면(에러) 재개 없이 처음부터.
      return 0;
    }
  };
  function saveProgress(key: string, offset: number) {
    try {
      localStorage.setItem(key, String(offset));
    } catch {
      // 저장소 접근이 거부되면(iframe·비공개 모드) 재개 지점을 못 남기지만 진행은 계속한다.
    }
  }

  async function run(dry: boolean) {
    if (!file) {
      setResult({ stage: 'no-file', error: '엑셀 파일을 먼저 선택해 주세요.' });
      return;
    }
    if (!productNo) {
      setResult({ stage: 'no-product', error: '어느 상품에 옮길지 먼저 선택해 주세요.' });
      return;
    }
    setBusy(true);
    setParsing(!parsed);
    setResult(null);

    let reviews = parsed;
    if (!reviews) {
      try {
        // 파싱은 동기라 큰 엑셀은 몇 초 걸린다. 그 사이 화면이 멈춘 것처럼 보이지 않게
        // 먼저 "읽는 중" 상태를 그려주고, 이벤트 루프에 양보한 뒤 파싱한다.
        await new Promise((r) => setTimeout(r, 0));
        const buf = await file.arrayBuffer();
        const r = parseReviewFile(buf);
        reviews = r.reviews;
        setParsed(reviews);
      } catch (e) {
        setResult({ stage: 'parse', error: (e as Error).message });
        setBusy(false);
        setParsing(false);
        return;
      }
    }
    setParsing(false);
    if (!reviews) return;

    if (dry) {
      const allowed = quota?.paid
        ? reviews.length
        : Math.max(0, (quota?.limit ?? FREE_LIMIT) - (quota?.used ?? 0));
      setResult({
        dryRun: true,
        count: reviews.length,
        allowed,
        paid: quota?.paid,
        sample: reviews.slice(0, 3),
      });
      setBusy(false);
      return;
    }

    // 실제 이관 — IMPORT_BATCH건씩 순차 배치로 보낸다. 한 배치가 막혀도 전체를 멈추지 않고
    // 이어서 보내고, 끝나고 한 번 더 재시도한다. 연속 MAX_CONSEC_FAILS번 실패는 시스템
    // 오류로 보고 멈춘다. 성공분은 배치마다 즉시 원장에 남아 목록·삭제에서 복구되며,
    // 재전송분은 서버가 내용 해시로 걸러 중복 등록되지 않는다(멱등).
    const rkey = resumeKey(productNo, file);
    const batchCount = Math.ceil(reviews.length / IMPORT_BATCH);
    let resumeIdx = Math.floor(readResume(rkey) / IMPORT_BATCH);
    if (resumeIdx >= batchCount) resumeIdx = 0;
    const resuming = resumeIdx > 0;
    let totalWritten = 0;
    let totalRejected = 0;
    let totalAlready = 0;
    let attempted = resumeIdx * IMPORT_BATCH;
    let quotaExhausted = false;
    let consecFails = 0;
    let abortMsg = '';
    let stoppedByConsecFails = false;
    let usedNow = quota?.used ?? 0;
    const results: ({ written: number; failed: number; already: number } | null)[] = new Array(batchCount).fill(null);
    // 재개(resume)로 건너뛴 앞부분 배치는 "이미 완료"로 채워 둔다 — 그렇지 않으면 아래
    // firstGap이 항상 0이 돼 재개 지점이 사라지고 남은 건수 계산도 부풀려진다.
    for (let i = 0; i < resumeIdx; i++) results[i] = { written: 0, failed: 0, already: 0 };
    let freeRemaining: number | null = quota?.paid
      ? null
      : Math.max(0, (quota?.limit ?? FREE_LIMIT) - (quota?.used ?? 0));
    setImportProgress({ written: attempted, total: reviews.length, failed: 0, resuming });

    const saveAt = (idx: number) => {
      const off = Math.min(idx * IMPORT_BATCH, reviews.length);
      saveProgress(rkey, off);
      setImportProgress({ written: attempted, total: reviews.length, failed: totalRejected, resuming });
    };
    const applyJson = (idx: number, json: { written?: number; failed?: number; already?: number; freeRemaining?: number | null; paid?: boolean }) => {
      const written = json.written ?? 0;
      const failed = json.failed ?? 0;
      const already = json.already ?? 0;
      results[idx] = { written, failed, already };
      totalWritten += written;
      totalRejected += failed;
      totalAlready += already;
      attempted += (idx + 1) * IMPORT_BATCH <= reviews.length ? IMPORT_BATCH : reviews.length - idx * IMPORT_BATCH;
      if (json.freeRemaining !== undefined && json.freeRemaining !== null) {
        freeRemaining = json.freeRemaining;
        if (!json.paid) {
          setQuota((q) => (q ? { ...q, used: Math.max(q.used, (q.limit ?? FREE_LIMIT) - freeRemaining!) } : q));
          usedNow = (quota?.limit ?? FREE_LIMIT) - freeRemaining;
        }
      }
      setImportProgress({ written: attempted, total: reviews.length, failed: totalRejected, resuming });
    };

    /** 한 배치를 보낸다. 'ok'/'quota'/'err' 셋 중 하나로 돌아온다. */
    const sendOne = async (idx: number) => {
      const slice = reviews.slice(idx * IMPORT_BATCH, (idx + 1) * IMPORT_BATCH);
      try {
        const res = await fetch('/api/reviews/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // 서버 함수가 60초 제한에 죽거나 응답이 없어도 연결을 끊어 화면이 갇히지 않게 한다.
          signal: AbortSignal.timeout(BATCH_FETCH_TIMEOUT_MS),
          body: JSON.stringify({ product_no: productNo, reviews: slice }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 402) return { kind: 'quota' as const, json };
        if (!res.ok) return { kind: 'err' as const, msg: String(json.error ?? '옮기는 중 문제가 생겼습니다.') };
        // 200인데 아무 카운트도 없으면 본문 파싱 실패·서버 오류다. 이걸 "완료"로 세면 진행
        // 지점이 그 배치를 건너뛰어 유실되므로 에러로 본다(재시도·재개 대상).
        if (!json.written && !json.failed && !json.already)
          return {
            kind: 'err' as const,
            msg: '응답을 받지 못했습니다. 다시 「옮기기」를 눌러 이어서 진행해 주세요.',
          };
        return { kind: 'ok' as const, json };
      } catch (e) {
        return { kind: 'err' as const, msg: (e as Error).message };
      }
    };

    try {
      for (let idx = resumeIdx; idx < batchCount; idx++) {
        if (quotaExhausted) break;
        let r = await sendOne(idx);
        if (r.kind === 'quota') {
          // 무료 한도 소진(또는 체험 만료) — 여기까지 기록된 것을 남기고 중단한다.
          quotaExhausted = true;
          usedNow = r.json.used ?? usedNow;
          if (r.json.quotaExhausted && !r.json.paywall) {
            // 배치 도중 무료 건수가 소진된 경우 — 페이월이 아니면 건수 안내로 보여준다.
            setResult({ quotaExceeded: true, used: usedNow, paywall: false });
          } else {
            setResult({ quotaExceeded: true, paywall: r.json.paywall, used: usedNow, expiredAt: r.json.expiredAt });
          }
          // 402 응답엔 잔여 한도가 없어 화면 상태가 낡는다 — 서버에서 다시 읽어온다.
          refreshQuota();
          saveAt(idx);
          break;
        }
        if (r.kind === 'err') {
          // 배치 하나가 실패해도 전체를 멈추지 않는다. 실패 배치는 끝에서 한 번 더 시도한다.
          consecFails++;
          if (!abortMsg) abortMsg = r.msg;
          if (consecFails >= MAX_CONSEC_FAILS) {
            stoppedByConsecFails = true;
            break;
          }
          r = await sendOne(idx); // 같은 실행 안 1회 재시도
          if (r.kind === 'quota') {
            quotaExhausted = true;
            usedNow = r.json.used ?? usedNow;
            setResult({ quotaExceeded: true, paywall: r.json.paywall, used: usedNow, expiredAt: r.json.expiredAt });
            refreshQuota();
            saveAt(idx);
            break;
          }
          if (r.kind === 'err') {
            // 재시도도 실패 — results에 기록하지 않아(미완료) 재개 지점이 이 배치에 남는다.
            // 다음 「옮기기」가 이 배치부터 다시 시도한다(중복은 서버가 걸러낸다).
            continue;
          }
          consecFails = 0;
          applyJson(idx, r.json);
          if (r.json.quotaExhausted) {
            quotaExhausted = true;
            setResult({ quotaExceeded: true, used: usedNow });
            saveAt(idx);
            break;
          }
          continue;
        }
        consecFails = 0;
        applyJson(idx, r.json);
        if (r.json.quotaExhausted) {
          // 무료 한도가 배치 도중 소진 — 이 배치의 일부만 옮겨졌다. 여기까지를 남기고 중단해,
          // 유료 전환 후 이 배치부터 이어서 하게 둔다.
          quotaExhausted = true;
          setResult({ quotaExceeded: true, used: usedNow });
          saveAt(idx);
          break;
        }
      }

      const firstGap = results.findIndex((r) => r === null);
      if (stoppedByConsecFails && !quotaExhausted) {
        // 연속 실패로 중단 — 진행 지점을 남겨 다음 「옮기기」가 이어서 진행하게 한다.
        saveAt(firstGap >= 0 ? firstGap : batchCount);
        setResult({
          stage: 'write',
          parsed: reviews.length,
          written: totalWritten,
          failed: totalRejected,
          already: totalAlready,
          skipped: reviews.length - totalWritten - totalAlready,
          error: abortMsg,
        });
      } else if (quotaExhausted) {
        // 한도 소진으로 중단해도 여기까지 옮겨진 글은 목록에 보이게 한다.
        loadImports(1, filterProduct);
      } else {
        if (firstGap >= 0) saveAt(firstGap);
        else {
          try {
            localStorage.removeItem(rkey);
          } catch {
            // 저장소 접근이 거부되면 남은 진행 지점이 다음 번에 재개로 오인될 수 있지만,
            // offset >= reviews.length면 readResume이 0으로 되돌리므로 실제 영향은 없다.
          }
        }
        // 파일 전체 중 아직 등록되지 않은 건수 — 고객이 "다 올라갔다"고 오해하지 않게 명확히 보여준다.
        const skipped = reviews.length - totalWritten - totalAlready;
        setResult({
          parsed: reviews.length,
          written: totalWritten,
          failed: totalRejected,
          already: totalAlready,
          skipped,
          freeRemaining,
          paid: quota?.paid,
        });
        if (!quota?.paid && typeof freeRemaining === 'number') {
          const used = (quota?.limit ?? FREE_LIMIT) - freeRemaining;
          setQuota((q) => (q ? { ...q, used } : q));
        }
        setFilterProduct('');
        loadImports(1, '');
      }
    } catch (e) {
      // 중간 실패 — 진행 지점을 남겨 두어 다음 「옮기기」가 이어서 진행하게 한다.
      const firstGap = results.findIndex((r) => r === null);
      saveAt(firstGap >= 0 ? firstGap : resumeIdx);
      setResult({
        stage: 'write',
        parsed: reviews.length,
        written: totalWritten,
        failed: totalRejected,
        already: totalAlready,
        skipped: reviews.length - totalWritten - totalAlready,
        error: (e as Error).message,
      });
    } finally {
      setBusy(false);
      setImportProgress(null);
    }
  }

  async function deleteImports(keys: string[]) {
    if (!keys.length || delBusy) return;
    setDelBusy(true);
    setImportedMsg('');
    setImportedError('');
    setDeleteProgress({ deleted: 0, total: keys.length, failed: 0 });
    let totalDeleted = 0;
    let totalFailed = 0;
    let firstErr = '';
    try {
      for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
        const chunk = keys.slice(i, i + DELETE_CHUNK);
        const res = await fetch('/api/imports', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ import_keys: chunk }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? '삭제하지 못했습니다.');
        totalDeleted += (json.deleted ?? []).length;
        totalFailed += (json.failed ?? []).length;
        if (!firstErr && json.failed?.length) firstErr = json.failed[0].error ?? '';
        setDeleteProgress({ deleted: totalDeleted, total: keys.length, failed: totalFailed });
      }
      if (totalDeleted) {
        // 마지막 페이지의 글을 다 지웠다면 page가 새 마지막 페이지를 넘어 "3/2페이지"처럼
        // 빈 목록이 보이지 않게, 삭제 후 총건수로 계산한 마지막 페이지로 조정한다.
        const remaining = Math.max(0, total - totalDeleted);
        const lastPage = Math.max(1, Math.ceil(remaining / PAGE_SIZE));
        await loadImports(Math.min(page, lastPage), filterProduct);
        setSelected(new Set());
      }
      // 목록 재조회(loadImports)가 메시지 상태를 먼저 지우므로, 완료 메시지는 그 뒤에 남긴다.
      setImportedMsg(
        totalFailed
          ? `삭제 완료 ${totalDeleted}건 · 실패 ${totalFailed}건 (${firstErr})`
          : `삭제 완료 ${totalDeleted}건`,
      );
    } catch (e) {
      setImportedError((e as Error).message);
    } finally {
      setDelBusy(false);
      setDeleteProgress(null);
    }
  }

  /** 현재 필터의 모든 옮긴 리뷰를 메이크샵 후기에서 지우고 원장도 정리한다. 서버가 hasMore로 순회한다. */
  async function deleteAllFiltered() {
    if (
      !window.confirm(
        '현재 필터(전체 상품 포함)의 모든 리뷰를 삭제할까요? 쇼핑몰 상품 후기에서도 함께 삭제됩니다.',
      )
    )
      return;
    if (delBusy) return;
    setDelBusy(true);
    setImportedMsg('');
    setImportedError('');
    // 전체 삭제는 목록 총 건수를 기준으로 진행률을 보여준다.
    const totalTarget = Math.max(1, total);
    setDeleteProgress({ deleted: 0, total: totalTarget, failed: 0 });
    let totalDeleted = 0;
    let totalFailed = 0;
    let firstErr = '';
    try {
      let hasMore = true;
      while (hasMore) {
        const res = await fetch('/api/imports', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true, product_no: filterProduct || undefined }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? '삭제하지 못했습니다.');
        totalDeleted += (json.deleted ?? []).length;
        totalFailed += (json.failed ?? []).length;
        if (!firstErr && json.failed?.length) firstErr = json.failed[0].error ?? '';
        hasMore = !!json.hasMore;
        setDeleteProgress({ deleted: totalDeleted, total: totalTarget, failed: totalFailed });
      }
      if (totalDeleted) {
        await loadImports(1, filterProduct);
        setSelected(new Set());
      }
      // 목록 재조회(loadImports)가 메시지 상태를 먼저 지우므로, 완료 메시지는 그 뒤에 남긴다.
      setImportedMsg(
        totalFailed
          ? `삭제 완료 ${totalDeleted}건 · 실패 ${totalFailed}건 (${firstErr})`
          : `삭제 완료 ${totalDeleted}건`,
      );
    } catch (e) {
      setImportedError((e as Error).message);
    } finally {
      setDelBusy(false);
      setDeleteProgress(null);
    }
  }

  async function useSample() {
    const blob = await fetch('/sample-reviews.xlsx').then((r) => r.blob());
    setFile(new File([blob], 'sample-reviews.xlsx', { type: blob.type }));
    setParsed(null);
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

      {quota && (
        <SubscriptionCard
          quota={quota}
          demoMode={billing?.demoMode ?? false}
          onPay={pay}
          onRefund={refund}
          refunding={refunding}
        />
      )}

      {billing?.demoMode && billing.history.length > 0 && (
        <div className="mt-4 rounded-lg border border-neutral-200 bg-white p-4">
          <p className="text-[11px] font-semibold text-neutral-600">
            결제/환불 콜백 이력 (심사 확인용 — callback HTTP 201 = 메이크샵 전송 성공)
          </p>
          <ul className="mt-2 space-y-1 text-[11px] text-neutral-600">
            {billing.history.map((h) => (
              <li key={h.id} className="flex items-center gap-2">
                <span className={h.kind === 'payment' ? 'text-blue-700' : 'text-red-700'}>
                  {h.kind === 'payment' ? '결제' : '환불'}
                </span>
                <span>{h.amount.toLocaleString()}원</span>
                <span>만료 {kstDate(h.expiredAt)}</span>
                <span
                  className={`rounded px-1.5 py-0.5 font-mono ${
                    h.callbackStatus === 201 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
                  }`}
                >
                  callback {h.callbackStatus ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

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

            <li className={result?.stage === 'no-product' ? 'rounded-lg ring-2 ring-amber-400/70' : ''}>
              <div className="font-medium">2. 어느 상품에 넣을지 고르세요</div>
              <select
                className="mt-2 w-full rounded border p-2"
                value={productNo}
                onChange={(e) => {
                  setProductNo(e.target.value);
                  // 미선택 안내가 떠 있으면 고르는 순간 지운다.
                  setResult(null);
                }}
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

            <li className={result?.stage === 'no-file' ? 'rounded-lg ring-2 ring-amber-400/70' : ''}>
              <div className="font-medium">3. 엑셀 파일을 올리세요</div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  setParsed(null);
                  setResult(null);
                  // 같은 파일을 다시 골라도 onChange가 다시 발동하게 value를 비운다.
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || parsing}
                className="mt-2 inline-block rounded border px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-40"
              >
                파일 선택
              </button>
              <div className="mt-2 text-xs text-neutral-500">
                엑셀이 아직 없다면{' '}
                <button onClick={useSample} className="underline">샘플 엑셀로 체험하기</button>
                {' · '}
                <a href="/sample-reviews.xlsx" className="underline">샘플 내려받기</a>
              </div>
              {file && <div className="mt-1 text-xs font-medium text-green-700">✓ 선택된 파일: {file.name}</div>}
            </li>
          </ol>

          <div className="mt-6 flex gap-2">
            <button
              onClick={() => run(true)}
              disabled={busy || parsing}
              className="rounded border px-4 py-2 text-sm disabled:opacity-40"
            >
              미리보기
            </button>
            <button
              onClick={() => run(false)}
              disabled={busy || parsing}
              className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
            >
              {busy && importProgress
                ? `옮기는 중 ${Math.round(
                    importProgress.total > 0 ? (importProgress.written / importProgress.total) * 100 : 0,
                  )}%…`
                : busy || parsing
                  ? '읽는 중…'
                  : '옮기기'}
            </button>
          </div>

          {!busy && !parsing && (!file || !productNo) && (
            <p className="mt-2 text-xs text-neutral-500">
              {!file ? '① 엑셀 파일을 선택하고, ② 상품을 고르면 버튼을 누를 수 있어요.' : '② 상품을 먼저 선택해 주세요.'}
            </p>
          )}

          {parsing && (
            <div className="mt-4 rounded border border-neutral-200 bg-white p-3 text-xs">
              <div className="flex items-center gap-2 text-neutral-600">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border border-neutral-400 border-t-transparent align-[-1px]" />
                <span className="font-medium">엑셀을 읽는 중입니다…</span>
              </div>
              <p className="mt-1 text-[11px] text-neutral-400">
                리뷰가 많으면 몇 초 걸릴 수 있습니다. 화면이 잠깐 멈춘 것처럼 보여도 기다리시면 됩니다.
              </p>
            </div>
          )}

          {importProgress && (
            <div className="mt-4 rounded border border-neutral-200 bg-white p-3 text-xs">
              <div className="flex justify-between text-neutral-600">
                <span>
                  옮기는 중 {Math.min(importProgress.written, importProgress.total)} /{' '}
                  {importProgress.total}건
                  {importProgress.resuming ? ' (이어서 진행)' : ''}
                  {importProgress.failed > 0 ? ` · 실패 ${importProgress.failed}건` : ''}
                </span>
                <span className="font-semibold">
                  {importProgress.total > 0
                    ? `${Math.round((importProgress.written / importProgress.total) * 100)}%`
                    : '0%'}
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full rounded-full bg-neutral-100">
                <div
                  className="h-1.5 rounded-full bg-black transition-all"
                  style={{
                    width: `${
                      importProgress.total > 0
                        ? Math.min(100, Math.round((importProgress.written / importProgress.total) * 100))
                        : 0
                    }%`,
                  }}
                />
              </div>
              <p className="mt-1 text-[11px] text-neutral-400">
                한 번에 {IMPORT_BATCH}건씩 나눠 옮겨서, 1만 건도 끊기지 않게 진행합니다. 중간에 멈추면
                이 화면에서 다시 눌러 이어서 하세요. 이미 옮긴 리뷰를 다시 보내도 중복 등록되지 않습니다.
              </p>
            </div>
          )}

          <p className="mt-8 border-t pt-4 text-xs text-neutral-500">
            {quota?.status === 'paid'
              ? '유료 플랜 — 횟수 제한 없이 이용할 수 있어요.'
              : '무료체험 기간 동안 20건까지 옮겨볼 수 있어요.'}{' '}
            · <a href="/privacy" className="underline">개인정보처리방침</a>
          </p>

          {result && (
            <div className="mt-6 rounded bg-neutral-50 p-4 text-sm">
              {result.quotaExceeded ? (
                result.paywall ? (
                  <div>
                    <p className="font-medium text-red-700">무료체험 기간이 끝났습니다.</p>
                    <p className="mt-1 text-xs text-neutral-600">결제 후 계속 이용할 수 있습니다.</p>
                    {billing?.demoMode ? (
                      <button
                        onClick={pay}
                        disabled={paying}
                        className="mt-3 rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
                      >
                        {paying ? '결제 처리 중…' : '결제하고 계속 이용하기'}
                      </button>
                    ) : (
                      <p className="mt-2 text-xs text-neutral-500">결제·환불 문의: kwan765@naver.com</p>
                    )}
                  </div>
                ) : (
                  <div>
                    <p className="font-medium">무료 20건을 모두 사용했어요</p>
                    <p className="mt-1 text-xs text-neutral-600">
                      유료 플랜(월 결제)으로 전환하면 남은 리뷰를 이어서 옮길 수 있어요.
                    </p>
                    {billing?.demoMode ? (
                      <button
                        onClick={pay}
                        disabled={paying}
                        className="mt-3 rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
                      >
                        {paying ? '결제 처리 중…' : '결제하고 계속 이용하기'}
                      </button>
                    ) : (
                      <p className="mt-2 text-xs text-neutral-500">결제·환불 문의: kwan765@naver.com</p>
                    )}
                    <p className="mt-2 text-xs text-neutral-500">
                      여기까지 옮겨진 리뷰는 아래 목록에 남아 있습니다.
                    </p>
                  </div>
                )
              ) : result.stage === 'no-file' || result.stage === 'no-product' ? (
                <div>
                  <p className="font-medium text-amber-700">
                    {result.stage === 'no-file'
                      ? '엑셀 파일을 먼저 선택해 주세요.'
                      : '어느 상품에 옮길지 먼저 선택해 주세요.'}
                  </p>
                  <p className="mt-1 text-xs text-neutral-600">
                    {result.stage === 'no-file'
                      ? '아래 ③ 상자(노란색 테두리)에서 엑셀 파일을 고르면 바로 진행할 수 있어요.'
                      : '아래 ② 상자(노란색 테두리)에서 옮길 상품을 고르면 바로 진행할 수 있어요.'}
                  </p>
                </div>
              ) : result.error ? (
                <p className="text-red-600">
                  {result.stage === 'parse'
                    ? '엑셀을 읽지 못했습니다. 구매평 엑셀 파일이 맞는지 확인해 주세요.'
                    : '옮기는 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.'}
                  <span className="mt-1 block text-xs text-neutral-500">{result.error}</span>
                  {result.stage === 'write' && typeof result.written === 'number' ? (
                    <span className="mt-2 block text-xs text-neutral-600">
                      여기까지 {result.written}건은 옮겨져 목록에 남아 있습니다.
                      {(result.already ?? 0) > 0 ? ` (이미 옮겨진 ${result.already}건 제외)` : ''}
                      {' '}
                      「옮기기」를 다시 누르면 이어서 진행됩니다.
                    </span>
                  ) : null}
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
                  {!result.paid && (result.count ?? 0) > (result.allowed ?? Infinity) ? (
                    <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-3">
                      <p className="text-xs font-medium text-amber-800">
                        {(result.allowed ?? 0) > 0
                          ? `무료로는 ${result.allowed}건까지 옮겨져요`
                          : '무료 20건을 모두 사용했어요'}
                      </p>
                      <p className="mt-1 text-[11px] text-amber-700">
                        읽은 {result.count}건 중 {Math.min(result.allowed ?? 0, result.count ?? 0)}건만 무료로
                        옮겨집니다. 전체를 옮기려면 유료 플랜으로 전환해 주세요.
                      </p>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-neutral-500">아직 아무것도 등록되지 않았습니다. 「옮기기」를 누르면 실제로 등록됩니다.</p>
                  )}
                </>
              ) : result.refunded || result.paid || result.callbackStatus != null ? (
                <>
                  <p className="font-medium">
                    {result.refunded
                      ? '환불 처리 완료 — 앱 이용이 종료되었습니다.'
                      : '결제가 완료되었습니다. 리뷰 옮기기를 계속 사용할 수 있어요.'}
                  </p>
                  {typeof result.callbackStatus === 'number' && (
                    <p className="mt-1 text-xs">
                      {result.refunded ? '환불' : '결제'} 콜백 전송 완료 · HTTP{' '}
                      <span className={`font-mono font-semibold ${result.callbackStatus === 201 ? 'text-emerald-700' : 'text-red-700'}`}>
                        {result.callbackStatus}
                      </span>{' '}
                      {result.callbackStatus === 201 ? '(메이크샵 수신 성공 — 만료일 자동 갱신)' : '(수신 실패 — 관리자에게 문의)'}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="font-medium">구매평 {result.written}건을 옮겼습니다.</p>
                  <p className="mt-1 text-xs text-neutral-500">
                    이제 상품 상세페이지 후기에서 확인할 수 있습니다.
                  </p>
                  {(() => {
                    // 파일 전체 중 아직 등록되지 않은 건수 — 고객이 "다 올라갔다"고 오해하지 않게 명확히 보여준다.
                    const remaining = Math.max(0, (result.parsed ?? 0) - (result.written ?? 0) - (result.already ?? 0));
                    return remaining > 0 ? (
                      <p className="mt-1 text-xs font-medium text-amber-600">
                        파일의 {result.parsed}건 중 아직 {remaining}건이 등록되지 않았어요.{' '}
                        「옮기기」를 다시 누르면 중복 없이 이어서 등록됩니다.
                      </p>
                    ) : null;
                  })()}
                  {(result.failed ?? 0) > 0 ? (
                    <p className="mt-1 text-xs text-amber-600">
                      (메이크샵에서 거부된 {result.failed}건은 다시 눌러도 실패할 수 있어요)
                    </p>
                  ) : null}
                  {(result.already ?? 0) > 0 ? (
                    <p className="mt-1 text-xs text-neutral-500">
                      (이미 옮겨진 {result.already}건은 중복이라 건너뛰었습니다)
                    </p>
                  ) : null}
                  {!result.paid && (result.skipped ?? 0) > 0 ? (
                    <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-3">
                      <p className="text-xs font-medium text-amber-800">나머지 {result.skipped}건이 남아 있어요</p>
                      <p className="mt-1 text-[11px] text-amber-700">
                        무료 20건을 모두 사용해 일부만 옮겨졌습니다. 유료 플랜으로 전환하면 남은 리뷰를 이어서
                        옮길 수 있어요.
                      </p>
                      {billing?.demoMode && (
                        <button
                          onClick={pay}
                          disabled={paying}
                          className="mt-2 rounded bg-black px-3 py-1.5 text-xs text-white disabled:opacity-40"
                        >
                          {paying ? '결제 처리 중…' : '결제하고 계속 이용하기'}
                        </button>
                      )}
                    </div>
                  ) : (result.skipped ?? 0) > 0 ? (
                    <p className="mt-1 text-xs text-neutral-500">(건너뜀 {result.skipped}건)</p>
                  ) : null}
                </>
              )}
            </div>
          )}

          {/* 리뷰이사가 옮긴 리뷰 관리 — 옮긴 글을 원장에 기록해 두고 필터·삭제할 수 있다 */}
          <div className="mt-8 border-t pt-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">리뷰이사가 옮긴 리뷰 관리</h2>
              <button
                onClick={() => loadImports(page, filterProduct)}
                className="rounded border px-3 py-1 text-xs hover:bg-neutral-50"
              >
                새로고침
              </button>
            </div>
            <p className="mt-1 text-xs text-neutral-500">
              삭제하면 쇼핑몰 상품 후기에서도 함께 지워집니다. 목록은 {PAGE_SIZE}건씩 보여드립니다.
              새로 옮긴 리뷰는 바로 여기 나타납니다.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                className="rounded border p-1.5 text-xs"
                value={filterProduct}
                onChange={(e) => {
                  setFilterProduct(e.target.value);
                  // 다른 상품으로 필터를 바꾸면 안 보이는 행이 선택돼 있지 않게 선택을 비운다.
                  setSelected(new Set());
                  loadImports(1, e.target.value);
                }}
              >
                <option value="">전체 상품</option>
                {products.map((p) => (
                  <option key={p.no} value={p.no}>
                    [{p.no}] {p.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => deleteImports([...selected])}
                disabled={delBusy || selected.size === 0}
                className="rounded bg-black px-3 py-1.5 text-xs text-white disabled:opacity-40"
              >
                선택 삭제 ({selected.size})
              </button>
              <button
                onClick={deleteAllFiltered}
                disabled={delBusy || total === 0}
                className="rounded border px-3 py-1.5 text-xs text-red-600 disabled:opacity-40"
              >
                전체 삭제 ({total}건)
              </button>
              {delBusy && (
                <span className="text-xs text-neutral-500">
                  삭제하는 중…
                </span>
              )}
            </div>

            {deleteProgress && (
              <div className="mt-3 rounded border border-neutral-200 bg-white p-3 text-xs">
                <div className="flex justify-between text-neutral-600">
                  <span>
                    삭제하는 중 {Math.min(deleteProgress.deleted, deleteProgress.total)} /{' '}
                    {deleteProgress.total}건
                    {deleteProgress.failed > 0 ? ` · 실패 ${deleteProgress.failed}건` : ''}
                  </span>
                  <span className="font-semibold">
                    {deleteProgress.total > 0
                      ? `${Math.round(
                          Math.min(100, (deleteProgress.deleted / deleteProgress.total) * 100),
                        )}%`
                      : '0%'}
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full rounded-full bg-neutral-100">
                  <div
                    className="h-1.5 rounded-full bg-black transition-all"
                    style={{
                      width: `${
                        deleteProgress.total > 0
                          ? Math.min(
                              100,
                              Math.round((deleteProgress.deleted / deleteProgress.total) * 100),
                            )
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
            )}

            {importedError && <p className="mt-2 text-xs text-red-600">{importedError}</p>}
            {importedMsg && <p className="mt-2 text-xs text-neutral-600">{importedMsg}</p>}

            {imports === null ? (
              <p className="mt-3 text-xs text-neutral-400">목록을 불러오는 중입니다…</p>
            ) : imports.length === 0 ? (
              <p className="mt-3 text-xs text-neutral-400">
                기록된 리뷰가 없습니다. (새로 옮긴 리뷰부터 표시됩니다)
              </p>
            ) : (
              <>
                <ul className="mt-3 max-h-72 space-y-1.5 overflow-y-auto text-xs">
                  {imports.map((r) => {
                    const pname =
                      products.find((p) => p.no === r.product_uid)?.name ?? `상품 ${r.product_uid}`;
                    return (
                      <li key={r.import_key} className="flex items-start gap-2 rounded border bg-white p-2">
                        <input
                          type="checkbox"
                          checked={selected.has(r.import_key)}
                          onChange={(e) =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(r.import_key);
                              else next.delete(r.import_key);
                              return next;
                            })
                          }
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-neutral-800">
                            <span className="font-medium">{pname}</span>
                            <span className="text-amber-500"> ★{r.score}</span>
                            {' · '}
                            <span>{r.writer}</span>
                          </div>
                          <div className="mt-0.5 truncate text-neutral-400">{r.content}</div>
                          <div className="mt-0.5 text-neutral-400">
                            {r.created_date ? `원 작성일 ${r.created_date}` : ''}
                            {' · '}옮긴 시각 {new Date(r.imported_at).toLocaleString('ko-KR')}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-2 flex items-center justify-between text-xs text-neutral-500">
                  <span>
                    {total}건 중 {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)}건 ·{' '}
                    {page}/{totalPages}페이지
                  </span>
                  <span className="flex gap-1">
                    <button
                      onClick={() => loadImports(page - 1, filterProduct)}
                      disabled={page <= 1}
                      className="rounded border px-2 py-0.5 disabled:opacity-40"
                    >
                      이전
                    </button>
                    <button
                      onClick={() => loadImports(page + 1, filterProduct)}
                      disabled={page >= totalPages}
                      className="rounded border px-2 py-0.5 disabled:opacity-40"
                    >
                      다음
                    </button>
                  </span>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </main>
  );
}
