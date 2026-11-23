"use client";
import { useCallback, useEffect, useState } from "react";
import { api, download, won } from "../lib/api";
import {
  Book,
  Entry,
  BudgetItem,
  budgetPayload,
  entryPayload,
} from "../lib/annual";
import { statusClass } from "../lib/ui";
import { usePptDownload, useWorkspaceDirty } from "./AppShell";
import Dialog from "./Dialog";
import SaveNotice from "./SaveNotice";
import BudgetEditor from "./BudgetEditor";
import EntryGrid from "./EntryGrid";
import ReceiptManager from "./ReceiptManager";
import FinalizeDialog from "./FinalizeDialog";
import VersionHistory from "./VersionHistory";
import AnnualExcelImport from "./AnnualExcelImport";

type Tab = "budget" | "entries" | "receipts" | "history";
export default function AnnualLedger({ kind }: { kind: "ordinary" | "b" }) {
  const label = kind === "ordinary" ? "경상비" : "B";
  const downloadPpt = usePptDownload();
  const [books, setBooks] = useState<Book[]>([]),
    [book, setBook] = useState<Book | null>(null),
    [rows, setRows] = useState<Entry[]>([]),
    [budget, setBudget] = useState<BudgetItem[]>([]),
    [tab, setTab] = useState<Tab>(kind === "ordinary" ? "budget" : "entries"),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saveNotice, setSaveNotice] = useState(""),
    [notice, setNotice] = useState(""),
    [childDirty, setChildDirty] = useState(false),
    [reviewReceiptId, setReviewReceiptId] = useState<number | null>(null),
    [creating, setCreating] = useState(false),
    [finalizing, setFinalizing] = useState(false),
    [importTarget, setImportTarget] = useState<"entries" | "budget" | null>(
      null,
    ),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [includeUnknown, setIncludeUnknown] = useState(false),
    [excludeCarry, setExcludeCarry] = useState(false);
  const globalDirty = useWorkspaceDirty();
  const rowDirty =
    !!book &&
    JSON.stringify(entryPayload(rows)) !==
      JSON.stringify(entryPayload(book.entries));
  const budgetDirty =
    !!book &&
    JSON.stringify(budgetPayload(budget)) !==
      JSON.stringify(budgetPayload(book.budget));
  const dirty = rowDirty || budgetDirty || childDirty,
    locked = book?.status === "최종 확정";
  const inform = useCallback((s: string) => {
    setNotice(s);
    setTimeout(() => setNotice(""), 4000);
  }, []);
  function install(b: Book) {
    setBook(b);
    setRows(b.entries);
    setBudget(b.budget);
    setChildDirty(false);
  }
  const refresh = useCallback(async () => {
    if (!book) return;
    const b = await api<Book>(`/${kind}/books/${book.id}`);
    install(b);
    const list = await api<Book[]>(`/${kind}/books`);
    setBooks(list);
  }, [book?.id, kind]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<Book[]>(`/${kind}/books`)
      .then((list) => {
        if (cancelled) return;
        setBooks(list);
        if (list.length) {
          install(list[0]);
          setFrom(`${list[0].year}-01-01`);
          setTo(`${list[0].year}-12-31`);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [kind]);
  useEffect(() => {
    globalDirty(dirty);
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      globalDirty(false);
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty, globalDirty]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function guard(fn: () => void) {
    if (dirty) {
      setSaveNotice(
        childDirty
          ? "저장하지 않은 영수증 검토값이 있습니다. 검토 팝업에서 ‘검토값 확인’을 누른 뒤 이동해 주세요."
          : "저장하지 않은 장부 변경사항이 있습니다. 목록 위 오른쪽의 ‘임시 저장’을 누른 뒤 이동해 주세요.",
      );
      return;
    }
    fn();
  }
  async function save() {
    if (!book) return;
    if (childDirty) throw new Error("영수증 검토값을 먼저 저장하세요.");
    let current = book;
    if (budgetDirty)
      current = await api<Book>(`/${kind}/books/${book.id}/budget`, "PUT", {
        version: current.version,
        items: budgetPayload(budget),
      });
    if (rowDirty)
      current = await api<Book>(`/${kind}/books/${book.id}/entries`, "PUT", {
        version: current.version,
        entries: entryPayload(rows),
      });
    install(current);
    setBooks(await api<Book[]>(`/${kind}/books`));
    inform("장부 초안을 임시 저장했습니다.");
  }
  async function exportFile(type: "excel" | "pptx" | "zip") {
    if (!book) return;
    const params = new URLSearchParams();
    if (!book.latest_final_version) params.set("draft", "true");
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (type === "pptx" && includeUnknown)
      params.set("include_unverified", "true");
    const path =
      type === "excel"
        ? "excel/export"
        : `receipts/export-${type === "pptx" ? "pptx" : "zip"}`;
    const downloadFile = type === "pptx" ? downloadPpt : download;
    await downloadFile(
      `/${kind}/books/${book.id}/${path}?${params}`,
      `${book.latest_final_version ? "" : "DRAFT_"}${label}_${book.year}_${from}_${to}.${type === "excel" ? "xlsx" : type}`,
    );
  }
  async function exportChurchLedger() {
    if (!book) return;
    const draft = book.status !== "최종 확정";
    await download(
      `/ordinary/books/${book.id}/excel/export-church-ledger${draft ? "?draft=true" : ""}`,
      `${draft ? "DRAFT_" : ""}${book.year}_교회_장부.xlsx`,
    );
  }
  const stats = book?.totals;
  const draftIncome = rows.reduce((s, x) => s + (x.income_krw || 0), 0),
    draftExpense = rows.reduce((s, x) => s + (x.expense_krw || 0), 0),
    totalBudget = budget
      .filter((i) => i.level === 3)
      .reduce((s, x) => s + x.budget_krw, 0);
  return (
    <main className="workspace annual-workspace">
      <div className="breadcrumb">
        워크스페이스 <span>/</span>
        {label}
      </div>
      <section className="page-heading">
        <div>
          <p className="eyebrow">
            {kind === "ordinary"
              ? "ORDINARY BUDGET & LEDGER"
              : "ANNUAL INCOME & EXPENSE"}
          </p>
          <h1>{label} 관리</h1>
          <p className="muted">
            연도별 독립 장부로 수입과 지출, 영수증을 관리합니다.
          </p>
        </div>
        <div className="actions">
          <select
            aria-label={`${label} 연도 선택`}
            value={book?.id || ""}
            onChange={(e) => {
              if (
                dirty &&
                !confirm("저장하지 않은 변경사항을 버리고 연도를 바꿀까요?")
              )
                return;
              const b = books.find((b) => b.id === Number(e.target.value));
              if (b) {
                install(b);
                setFrom(`${b.year}-01-01`);
                setTo(`${b.year}-12-31`);
              }
            }}
          >
            <option value="" disabled>
              생성된 연도 선택
            </option>
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.year}년 · {b.status}
              </option>
            ))}
          </select>
          <button
            className="primary"
            onClick={() => guard(() => setCreating(true))}
          >
            ＋ 연도별 장부 생성
          </button>
        </div>
      </section>
      {error && (
        <div className="alert error" role="alert">
          {error}
          <button onClick={() => setError("")}>닫기</button>
        </div>
      )}
      {loading ? (
        <div className="empty">장부를 불러오는 중입니다…</div>
      ) : !book ? (
        <section className="event-panel empty">
          <span className="empty-icon">▦</span>
          <h3>아직 생성된 {label} 장부가 없습니다.</h3>
          <p>
            연도를 선택해 장부를 명시적으로 생성하세요. 다른 연도 거래는
            자동으로 복사하지 않습니다.
          </p>
          <button onClick={() => setCreating(true)}>첫 연도 장부 만들기</button>
        </section>
      ) : (
        <>
          <div className="stats">
            {kind === "ordinary" ? (
              <>
                <Card label="선택 연도 예산 · 편집값" value={totalBudget} />
                <Card label="확정 실지출" value={stats!.expense_krw} />
                <Card
                  label="예산 잔액"
                  value={totalBudget - stats!.expense_krw}
                />
                <Card
                  label="집행률"
                  text={
                    totalBudget
                      ? `${((stats!.expense_krw / totalBudget) * 100).toFixed(1)}%`
                      : "—"
                  }
                />
              </>
            ) : (
              <>
                <Card
                  label={`확정 총수입${excludeCarry ? " · 이월 제외" : ""}`}
                  value={
                    excludeCarry
                      ? stats!.income_excluding_carryover_krw
                      : stats!.income_krw
                  }
                />
                <Card label="확정 총지출" value={stats!.expense_krw} />
                <Card
                  label="확정 수지 차액"
                  value={
                    stats!.balance_krw -
                    (excludeCarry ? stats!.carryover_krw : 0)
                  }
                />
                <Card label="확정 이월금" value={stats!.carryover_krw} />
              </>
            )}
          </div>
          <section className="event-panel">
            <div className="annual-heading">
              <div>
                <h2>
                  {book.year}년 {label}{" "}
                  <span className={`badge ${statusClass(book.status)}`}>
                    {book.status}
                  </span>
                </h2>
                <p className="small muted">
                  공식 집계:{" "}
                  {book.latest_final_version
                    ? `확정 v${book.latest_final_version}`
                    : "확정본 없음 · 0원"}{" "}
                  · 편집 중 수입 ₩ {won(draftIncome)} / 지출 ₩{" "}
                  {won(draftExpense)} / 차액 ₩ {won(draftIncome - draftExpense)}
                </p>
              </div>
              {kind === "b" && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={excludeCarry}
                    onChange={(e) => setExcludeCarry(e.target.checked)}
                  />
                  공식 집계에서 이월금 제외
                </label>
              )}
            </div>
            <div className="tabs" role="tablist">
              {(
                [
                  ...(kind === "ordinary" ? [["budget", "예산 현황"]] : []),
                  ["entries", `${label} 장부`],
                  ["receipts", "영수증 관리"],
                  ["history", "변경 이력"],
                ] as [Tab, string][]
              ).map(([id, name]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  className={tab === id ? "active" : ""}
                  onClick={() => id !== tab && guard(() => setTab(id))}
                >
                  {name}
                </button>
              ))}
            </div>
            <div
              className="record-actions"
              role="group"
              aria-label="저장 및 확정"
            >
              <span className={dirty ? "warning-text" : "muted"}>
                {dirty
                  ? "● 저장하지 않은 변경사항이 있습니다."
                  : "✓ 현재 장부가 저장되어 있습니다."}
              </span>
              <div className="actions wrap">
                {locked ? (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        await api(`/${kind}/books/${book.id}/reopen`, "POST", {
                          version: book.version,
                        });
                        await refresh();
                        inform(
                          "이전 확정본을 유지하고 재수정 초안을 열었습니다.",
                        );
                      })
                    }
                  >
                    수정 재오픈
                  </button>
                ) : (
                  <>
                    <button
                      disabled={!dirty || busy}
                      onClick={() => {
                        if (confirm("저장하지 않은 변경사항을 취소할까요?")) {
                          install(book);
                        }
                      }}
                    >
                      변경 취소
                    </button>
                    <button
                      className="primary"
                      disabled={
                        (!rowDirty && !budgetDirty) || childDirty || busy
                      }
                      onClick={() => action(save)}
                    >
                      임시 저장
                    </button>
                    <button
                      disabled={dirty || busy}
                      onClick={() => setFinalizing(true)}
                    >
                      최종 확정
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="annual-content">
              <div className="toolbar export-toolbar">
                <div className="actions wrap">
                  <label className="small">
                    출력 시작
                    <input
                      aria-label="출력 시작일"
                      type="date"
                      min={`${book.year}-01-01`}
                      max={`${book.year}-12-31`}
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </label>
                  <label className="small">
                    종료
                    <input
                      aria-label="출력 종료일"
                      type="date"
                      min={`${book.year}-01-01`}
                      max={`${book.year}-12-31`}
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </label>
                  <label className="check-label small">
                    <input
                      type="checkbox"
                      checked={includeUnknown}
                      onChange={(e) => setIncludeUnknown(e.target.checked)}
                    />
                    PPT 미확인 영수증 포함
                  </label>
                </div>
                <div className="actions wrap">
                  <button
                    disabled={
                      busy || locked || tab === "receipts" || tab === "history"
                    }
                    onClick={() =>
                      guard(() =>
                        setImportTarget(
                          tab === "budget" ? "budget" : "entries",
                        ),
                      )
                    }
                  >
                    ↥ Excel 장부 업로드
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      guard(() => action(() => exportFile("excel")))
                    }
                  >
                    ↧ Excel
                  </button>
                  {kind === "ordinary" && (
                    <button
                      disabled={busy}
                      onClick={() => guard(() => action(exportChurchLedger))}
                    >
                      ↧ 교회 장부 Excel
                    </button>
                  )}
                  <button
                    disabled={busy}
                    onClick={() =>
                      guard(() => action(() => exportFile("pptx")))
                    }
                  >
                    ↧ 영수증 ppt
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => guard(() => action(() => exportFile("zip")))}
                  >
                    ↧ 영수증 ZIP
                  </button>
                </div>
              </div>
              {tab === "budget" && (
                <BudgetEditor
                  key={book.id}
                  items={budget}
                  setItems={setBudget}
                  year={book.year}
                  locked={!!locked}
                />
              )}
              {tab === "entries" && (
                <EntryGrid
                  key={book.id}
                  book={book}
                  rows={rows}
                  setRows={setRows}
                  locked={!!locked}
                  onReceipt={setReviewReceiptId}
                />
              )}
              {(tab === "receipts" || reviewReceiptId !== null) && (
                <ReceiptManager
                  key={`${book.id}:${reviewReceiptId ?? "list"}`}
                  event={book.owner}
                  refresh={refresh}
                  action={action}
                  busy={busy || !!locked}
                  inform={inform}
                  onDirtyChange={setChildDirty}
                  reviewTarget={
                    reviewReceiptId === null
                      ? undefined
                      : {
                          id: reviewReceiptId,
                          onClose: () => setReviewReceiptId(null),
                        }
                  }
                  readOnlyReason={
                    reviewReceiptId !== null && (rowDirty || budgetDirty)
                      ? "영수증을 수정하려면 장부 변경사항을 먼저 저장하세요."
                      : undefined
                  }
                  hideCategories={kind === "b"}
                  categoryNames={Object.fromEntries(
                    book.budget
                      .filter((i) => i.level === 3 && i.category_id)
                      .map((i) => [i.category_id!, i.path || i.name]),
                  )}
                />
              )}
              {tab === "history" && (
                <VersionHistory
                  key={book.id}
                  event={book.owner}
                  action={action}
                />
              )}
            </div>
          </section>
        </>
      )}
      {saveNotice && (
        <SaveNotice message={saveNotice} onClose={() => setSaveNotice("")} />
      )}
      {creating && (
        <CreateBook
          kind={kind}
          books={books}
          onClose={() => setCreating(false)}
          onDone={async (b) => {
            install(b);
            setBooks(await api<Book[]>(`/${kind}/books`));
            setFrom(`${b.year}-01-01`);
            setTo(`${b.year}-12-31`);
            setCreating(false);
            inform(`${b.year}년 장부를 생성했습니다.`);
          }}
        />
      )}
      {finalizing && book && (
        <FinalizeDialog
          countLabel="거래"
          event={book.owner}
          onClose={() => setFinalizing(false)}
          onDone={async () => {
            setFinalizing(false);
            await refresh();
            inform("연도별 장부 확정본을 보관했습니다.");
          }}
        />
      )}
      {importTarget && book && (
        <AnnualExcelImport
          book={book}
          target={importTarget}
          onClose={() => setImportTarget(null)}
          onDone={async () => {
            setImportTarget(null);
            await refresh();
            inform("Excel 자료를 초안으로 반영했습니다.");
          }}
        />
      )}
      {notice && (
        <div className="toast" role="status">
          ✓ {notice}
        </div>
      )}
    </main>
  );
}
function Card({
  label,
  value,
  text,
}: {
  label: string;
  value?: number;
  text?: string;
}) {
  return (
    <div className="stat">
      <span>{label}</span>
      <div>
        {text ?? won(value)}
        {!text && <small>원</small>}
      </div>
      <p>선택 연도 장부 기준</p>
    </div>
  );
}
function CreateBook({
  kind,
  books,
  onClose,
  onDone,
}: {
  kind: "ordinary" | "b";
  books: Book[];
  onClose: () => void;
  onDone: (book: Book) => Promise<void>;
}) {
  const [year, setYear] = useState(
      books.length
        ? Math.max(...books.map((b) => b.year)) + 1
        : Number(
            new Date()
              .toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })
              .slice(0, 4),
          ),
    ),
    [source, setSource] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const previous = books.find((b) => b.year === year - 1);
  return (
    <Dialog
      title={`${kind === "ordinary" ? "경상비" : "B"} 연도별 장부 생성`}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onDone(
              await api<Book>(`/${kind}/books`, "POST", {
                year,
                copy_budget_from: source ? Number(source) : null,
              }),
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted">
          해당 연도의 독립 장부를 만듭니다. 전년도 거래와 영수증은 복사하지
          않습니다.
        </p>
        <label className="field">
          장부 연도
          <input
            required
            type="number"
            min="1900"
            max="2200"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          />
        </label>
        {kind === "ordinary" && (
          <label className="field">
            예산 항목 초기화
            <select
              aria-label="예산 항목 초기화"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">빈 예산표로 시작</option>
              {books.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.year}년 예산·항목만 복사
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === "b" && previous && (
          <p className="alert warning">
            전년도 확정 잔액 참고: ₩ {won(previous.totals.balance_krw)}.
            이월금은 생성 후 거래유형 ‘이월금’으로 직접 등록·승인하세요.
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button disabled={busy} className="primary">
            연도별 장부 생성
          </button>
        </div>
      </form>
    </Dialog>
  );
}
