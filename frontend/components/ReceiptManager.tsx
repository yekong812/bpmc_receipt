"use client";
import { useEffect, useRef, useState } from "react";
import { api, EventData, Receipt, won } from "../lib/api";
import { useSessionFilters } from "../lib/useSessionFilters";
import Dialog from "./Dialog";

const receiptColumns = [
  ["number", "No."],
  ["file", "원본파일"],
  ["date", "거래일시"],
  ["merchant", "상호 / 내역"],
  ["amount", "최종금액"],
  ["expense", "매칭 지출행"],
  ["status", "상태"],
] as const;
type SortColumn = (typeof receiptColumns)[number][0];
type AnalysisJob = {
  id: string;
  status: string;
  processed: number;
  total: number;
  input_tokens?: number;
  output_tokens?: number;
  estimated_cost_usd?: string | null;
  analysis_error_count?: number;
  error_message?: string;
};

const receiptFilterFields = [
  ["fromDate", "거래 시작일", "date"],
  ["toDate", "거래 종료일", "date"],
  ["amount", "금액", "number"],
] as const;
const receiptStatuses = ["대기", "검토 필요", "확인됨", "제외"];
const emptyFilters = {
  fromDate: "",
  toDate: "",
  amount: "",
  status: "",
};

function positionStatusDropdown(dropdown: HTMLDetailsElement) {
  if (!dropdown.open) return;
  const panel = dropdown.querySelector(".receipt-status-options");
  if (!panel) return;

  const trigger = dropdown.getBoundingClientRect();
  const scrollArea = dropdown.closest(".detail-body")?.getBoundingClientRect();
  const top = Math.max(0, scrollArea?.top ?? 0);
  const bottom = Math.min(
    window.innerHeight,
    scrollArea?.bottom ?? window.innerHeight,
  );
  const spaceAbove = trigger.top - top - 8;
  const spaceBelow = bottom - trigger.bottom - 8;
  const opensUp =
    spaceBelow < panel.scrollHeight + 2 && spaceAbove > spaceBelow;
  dropdown.toggleAttribute("data-open-up", opensUp);
  dropdown.style.setProperty(
    "--status-options-space",
    `${Math.max(0, opensUp ? spaceAbove : spaceBelow)}px`,
  );
}

export default function ReceiptManager({
  event,
  refresh,
  action,
  busy,
  inform,
  onDirtyChange,
  hideCategories = false,
  categoryNames,
  reviewTarget,
  readOnlyReason,
}: {
  event: EventData;
  refresh: () => Promise<void>;
  action: (fn: () => Promise<void>) => Promise<void>;
  busy: boolean;
  inform: (s: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  hideCategories?: boolean;
  categoryNames?: Record<number, string>;
  reviewTarget?: { id: number; onClose: () => void };
  readOnlyReason?: string;
}) {
  const [filters, setFilters] = useSessionFilters(
    `receipts:${event.id}:${event.created_at}`,
    emptyFilters,
  );
  const [checkedIds, setCheckedIds] = useState<number[]>([]);
  const [analysisConfirmation, setAnalysisConfirmation] = useState<
    number[] | null
  >(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisJob | null>(
    null,
  );
  const [sort, setSort] = useState<{
    column: SortColumn;
    ascending: boolean;
  }>({ column: "date", ascending: true });
  const [selected, setSelected] = useState<number | null>(
      reviewTarget?.id ?? null,
    ),
    [editing, setEditing] = useState<Receipt | null>(
      () => event.receipts.find((r) => r.id === reviewTarget?.id) ?? null,
    ),
    [suggestions, setSuggestions] = useState<
      {
        receipt_id: number;
        candidates: { expense_id: number; score: number }[];
      }[]
    >([]),
    [extractions, setExtractions] = useState<
      {
        id: number;
        analyzed_at: string;
        extracted_json: string;
        model_name: string;
        input_kind: string;
        usage_json: string;
        estimated_cost_usd: string | null;
        error_message: string;
      }[]
    >([]),
    [expense, setExpense] = useState(""),
    [allocated, setAllocated] = useState(
      String(editing?.final_amount_krw ?? ""),
    ),
    [newCat, setNewCat] = useState(""),
    [job, setJob] = useState<AnalysisJob | null>(null);
  const [llm, setLlm] = useState<{
    enabled: boolean;
    key_configured: boolean;
    model: string;
    mode: string;
    allow_images: boolean;
  } | null>(null);
  useEffect(() => {
    api<{ llm: NonNullable<typeof llm> }>("/health")
      .then((h) => setLlm(h.llm))
      .catch(() => {});
  }, []);
  const input = useRef<HTMLInputElement>(null);
  const statusDropdown = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function repositionStatusDropdown() {
      if (statusDropdown.current)
        positionStatusDropdown(statusDropdown.current);
    }
    function closeStatusDropdown(e: PointerEvent) {
      const dropdown = statusDropdown.current;
      if (
        dropdown?.open &&
        e.target instanceof Node &&
        !dropdown.contains(e.target)
      )
        dropdown.open = false;
    }
    document.addEventListener("pointerdown", closeStatusDropdown);
    window.addEventListener("resize", repositionStatusDropdown);
    document.addEventListener("scroll", repositionStatusDropdown, true);
    return () => {
      document.removeEventListener("pointerdown", closeStatusDropdown);
      window.removeEventListener("resize", repositionStatusDropdown);
      document.removeEventListener("scroll", repositionStatusDropdown, true);
    };
  }, []);
  const pending =
    !!editing &&
    JSON.stringify(editing) !==
      JSON.stringify(event.receipts.find((r) => r.id === editing.id));
  useEffect(() => {
    onDirtyChange(pending);
  }, [pending, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    api<typeof suggestions>(`/events/${event.id}/receipt-suggestions`)
      .then(setSuggestions)
      .catch(() => {});
  }, [event]);
  useEffect(() => {
    if (selected) {
      const r = event.receipts.find((r) => r.id === selected);
      setEditing(r ? { ...r } : null);
    }
  }, [selected, event]);
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let active = true;
    const id = setInterval(async () => {
      try {
        const j = await api<AnalysisJob>(`/jobs/${job.id}`);
        if (!active) return;
        setJob(j);
        if (j.status !== "running") {
          active = false;
          clearInterval(id);
          setAnalysisResult(j);
          await refresh().catch((e: Error) => inform(e.message));
        }
      } catch (e) {
        if (!active) return;
        setJob(null);
        inform((e as Error).message);
      }
    }, 1500);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [job?.id, job?.status, refresh, inform]);
  useEffect(() => {
    if (selected === null) return;
    let active = true;
    api<typeof extractions>(`/receipts/${selected}/extractions`)
      .then((history) => {
        if (active) setExtractions(history);
      })
      .catch(() => {
        if (active) setExtractions([]);
      });
    return () => {
      active = false;
    };
  }, [selected, event.version]);
  const analyzing = job?.status === "running";
  const confirmed = editing?.ocr_status === "확인됨";
  const excluded = editing?.ocr_status === "제외";
  function select(r: Receipt) {
    setSelected(r.id);
    setEditing({ ...r });
    setExtractions([]);
    setExpense("");
    setAllocated(String(r.final_amount_krw ?? ""));
  }
  function closeReview() {
    if (pending && !confirm("저장하지 않은 영수증 검토값을 버리고 닫을까요?"))
      return;
    setEditing(null);
    setSelected(null);
    reviewTarget?.onClose();
  }
  useEffect(() => {
    if (hideCategories && !newCat) {
      const c = event.categories.find((c) => c.is_active);
      if (c) setNewCat(String(c.id));
    }
  }, [hideCategories, event.categories, newCat]);
  const links = event.links.filter((l) => l.receipt_id === selected);
  const expenseNumbers = new Map(
    event.expenses.map((expense, i) => [expense.id, i + 1]),
  );
  const linkedRows = new Map<number, number[]>();
  for (const link of event.links) {
    const number = expenseNumbers.get(link.expense_id);
    if (number === undefined) continue;
    const numbers = linkedRows.get(link.receipt_id) ?? [];
    numbers.push(number);
    linkedRows.set(link.receipt_id, numbers);
  }
  const selectedStatuses = filters.status ? filters.status.split(",") : [];
  const allStatusesSelected = receiptStatuses.every((status) =>
    selectedStatuses.includes(status),
  );
  const visibleReceipts = event.receipts
    .map((receipt, i) => {
      const expenses = linkedRows.get(receipt.id) ?? [];
      return {
        receipt,
        expenses,
        number: receipt.receipt_number || i + 1,
        file: receipt.original_name,
        date: receipt.transaction_at || null,
        merchant: receipt.merchant || receipt.description || null,
        amount: receipt.final_amount_krw,
        expense: expenses.length ? Math.min(...expenses) : null,
        status: receipt.ocr_status,
      };
    })
    .filter(({ date, amount, status }) => {
      const day = date?.slice(0, 10);
      return (
        (!filters.fromDate || (day !== undefined && day >= filters.fromDate)) &&
        (!filters.toDate || (day !== undefined && day <= filters.toDate)) &&
        (filters.amount === "" || amount === Number(filters.amount)) &&
        (!selectedStatuses.length || selectedStatuses.includes(status))
      );
    });
  visibleReceipts.sort((a, b) => {
    const left = a[sort.column],
      right = b[sort.column];
    if (left === right) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    const order =
      typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right), "ko", { numeric: true });
    return sort.ascending ? order : -order;
  });
  const selectedReceipts = event.receipts.filter((r) =>
    checkedIds.includes(r.id),
  );
  const analysisIds = selectedReceipts
    .filter((r) => r.ocr_status !== "제외")
    .map((r) => r.id);
  const reviewIds = selectedReceipts
    .filter((r) => r.ocr_status === "대기" || r.ocr_status === "검토 필요")
    .map((r) => r.id);
  const restoreIds = selectedReceipts
    .filter((r) => r.ocr_status === "제외")
    .map((r) => r.id);
  const visibleIds = visibleReceipts.map(({ receipt }) => receipt.id);
  const allVisibleChecked =
    visibleIds.length > 0 &&
    checkedIds.length === visibleIds.length &&
    visibleIds.every((id) => checkedIds.includes(id));
  const manager = !reviewTarget && (
    <div>
      {llm && (
        <p className="muted small">
          {llm.enabled
            ? `외부 LLM: ${llm.model} · ${llm.mode} · ${llm.key_configured ? "API 키 설정됨" : "API 키 미설정"}${llm.allow_images ? " · 이미지 외부 전송 허용" : " · 이미지 외부 전송 차단"}`
            : "외부 LLM 꺼짐 · 로컬 OCR 사용"}
        </p>
      )}
      <div className="toolbar">
        <div className="actions wrap">
          <input
            hidden
            ref={input}
            type="file"
            accept=".zip,.jpg,.jpeg,.png,.webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f)
                action(async () => {
                  const d = new FormData();
                  d.append("file", f);
                  let r: {
                    uploaded_count: number;
                    analysis_receipt_ids: number[];
                    duplicate_count: number;
                  };
                  try {
                    r = await api(
                      `/events/${event.id}/receipts/upload`,
                      "POST",
                      d,
                    );
                  } catch (error) {
                    if (
                      (error as Error).message.includes("다른 장부") &&
                      confirm(
                        "다른 장부·행사에 같은 영수증이 있습니다. 중복 영수증을 제외 상태로 등록할까요?",
                      )
                    ) {
                      d.append("confirm_reuse", "true");
                      r = await api(
                        `/events/${event.id}/receipts/upload`,
                        "POST",
                        d,
                      );
                    } else throw error;
                  }
                  await refresh();
                  setCheckedIds(r.analysis_receipt_ids);
                  inform(
                    `${r.uploaded_count}장 업로드 · 중복 ${r.duplicate_count}장 제외 상태로 등록`,
                  );
                });
              e.target.value = "";
            }}
          />
          <button
            className="primary"
            disabled={busy || analyzing}
            onClick={() => input.current?.click()}
          >
            ↥ 영수증 ZIP 업로드
          </button>
          <button
            className="receipt-analysis-action"
            disabled={busy || analyzing || !analysisIds.length}
            onClick={() => setAnalysisConfirmation(analysisIds)}
          >
            {analyzing
              ? `분석 중 ${job?.processed}/${job?.total}`
              : `◎ 영수증 분석 시작${analysisIds.length ? ` (${analysisIds.length}장)` : ""}`}
          </button>
          <button
            className="delete-action"
            disabled={busy || analyzing || !selectedReceipts.length}
            onClick={() => {
              if (
                !confirm(
                  `선택한 영수증 ${selectedReceipts.length}장의 원본과 지출 연결을 삭제할까요? 지출 내역은 보관됩니다.`,
                )
              )
                return;
              action(async () => {
                await api(`/events/${event.id}/receipts`, "DELETE", {
                  receipt_ids: selectedReceipts.map((r) => r.id),
                });
                setCheckedIds([]);
                await refresh();
                inform(`영수증 ${selectedReceipts.length}장을 삭제했습니다.`);
              });
            }}
          >
            선택 영수증 삭제
            {selectedReceipts.length ? ` (${selectedReceipts.length}장)` : ""}
          </button>
          <button
            className="review"
            disabled={busy || analyzing || !reviewIds.length}
            onClick={() =>
              action(async () => {
                const result = await api<{ confirmed_count: number }>(
                  `/events/${event.id}/receipts/confirm`,
                  "POST",
                  { receipt_ids: reviewIds },
                );
                await refresh();
                inform(
                  `영수증 ${result.confirmed_count}장의 검토를 완료했습니다.`,
                );
              })
            }
          >
            일괄 검토
          </button>
          <button
            disabled={busy || analyzing || !restoreIds.length}
            onClick={() => {
              if (
                !confirm(
                  `선택한 제외 영수증 ${restoreIds.length}장을 대기 또는 검토 상태로 되돌릴까요?`,
                )
              )
                return;
              action(async () => {
                const result = await api<{ restored_count: number }>(
                  `/events/${event.id}/receipts/restore`,
                  "POST",
                  { receipt_ids: restoreIds },
                );
                await refresh();
                inform(
                  `영수증 ${result.restored_count}장을 대기/검토 상태로 되돌렸습니다.`,
                );
              });
            }}
          >
            선택 제외 해제
            {restoreIds.length ? ` (${restoreIds.length}장)` : ""}
          </button>
        </div>
      </div>
      <p className="muted small">
        JPG·PNG·WebP / ZIP당 최대 300장, 60MB (압축 해제 후 총 250MB) · 이미지
        한 장당 최대 20MB · 개별 이미지 업로드 가능 · 날짜·금액을 확인하고
        영수증을 연결하세요. 분석 후 지출 초안을 자동 생성하며 최종 확정은
        사용자만 할 수 있습니다. 분석할 영수증을 체크한 뒤 분석을 시작하세요.
      </p>
      {job && job.status !== "running" && (
        <p className="small muted">
          분석 작업 {job.status === "completed" ? "완료" : job.status} · 입력{" "}
          {job.input_tokens ?? 0} / 출력 {job.output_tokens ?? 0} 토큰 · 추정
          비용{" "}
          {job.estimated_cost_usd != null
            ? `$${job.estimated_cost_usd}`
            : "미산정"}{" "}
          · 분석 오류 {job.analysis_error_count ?? 0}건
        </p>
      )}
      {!!event.receipts.length && (
        <div
          className="filters receipt-filters"
          role="group"
          aria-label="영수증 검색"
        >
          {receiptFilterFields.map(([key, label, type]) => (
            <label key={key}>
              {label}
              <input
                type={type}
                min={type === "number" ? 0 : undefined}
                value={filters[key]}
                onChange={(e) =>
                  setFilters({ ...filters, [key]: e.target.value })
                }
              />
            </label>
          ))}
          <details
            ref={statusDropdown}
            className="receipt-status-filters"
            onToggle={(e) => positionStatusDropdown(e.currentTarget)}
            onBlur={(e) => {
              if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
                e.currentTarget.open = false;
            }}
          >
            <summary>
              상태{" "}
              {selectedStatuses.length && !allStatusesSelected
                ? `${selectedStatuses.length}개 선택`
                : "전체"}
            </summary>
            <div
              className="receipt-status-options"
              role="group"
              aria-label="영수증 상태"
            >
              <label className="check-label small receipt-status-select-all">
                <input
                  type="checkbox"
                  checked={allStatusesSelected}
                  ref={(checkbox) => {
                    if (checkbox)
                      checkbox.indeterminate =
                        selectedStatuses.length > 0 && !allStatusesSelected;
                  }}
                  onChange={(e) =>
                    setFilters({
                      ...filters,
                      status: e.target.checked ? receiptStatuses.join(",") : "",
                    })
                  }
                />
                전체 선택
              </label>
              {receiptStatuses.map((status) => (
                <label key={status} className="check-label small">
                  <input
                    type="checkbox"
                    checked={selectedStatuses.includes(status)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...selectedStatuses, status]
                        : selectedStatuses.filter((item) => item !== status);
                      setFilters({ ...filters, status: next.join(",") });
                    }}
                  />
                  {status}
                </label>
              ))}
            </div>
          </details>
          <button
            type="button"
            className="text-button"
            onClick={() => setFilters(emptyFilters)}
          >
            초기화
          </button>
          <span className="small muted" role="status">
            검색 결과 {visibleReceipts.length}건
          </span>
        </div>
      )}
      <div className="table-scroll receipt-table">
        <table>
          <thead>
            <tr>
              <th
                scope="col"
                className="receipt-select"
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return;
                  const input = e.currentTarget.querySelector("input");
                  if (input && !input.disabled) input.click();
                }}
              >
                <label className="receipt-select-hit">
                  <input
                    type="checkbox"
                    aria-label="현재 검색 결과 영수증 전체 선택"
                    disabled={busy || analyzing || !visibleIds.length}
                    checked={allVisibleChecked}
                    onChange={(e) =>
                      setCheckedIds(e.target.checked ? visibleIds : [])
                    }
                  />
                </label>
              </th>
              {receiptColumns.map(([column, label]) => {
                const active = sort.column === column;
                return (
                  <th
                    key={column}
                    scope="col"
                    className={column === "amount" ? "numeric" : undefined}
                    aria-sort={
                      active
                        ? sort.ascending
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      className="table-sort"
                      onClick={() =>
                        setSort({
                          column,
                          ascending: active ? !sort.ascending : true,
                        })
                      }
                    >
                      {label}{" "}
                      <span aria-hidden="true">
                        {active ? (sort.ascending ? "↑" : "↓") : "↕"}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleReceipts.map(
              ({ receipt: r, number, merchant, expenses }) => (
                <tr
                  tabIndex={0}
                  aria-haspopup="dialog"
                  key={r.id}
                  className={
                    selected === r.id ? "selected clickable" : "clickable"
                  }
                  onClick={() => select(r)}
                  onKeyDown={(e) => {
                    if (
                      e.target === e.currentTarget &&
                      (e.key === "Enter" || e.key === " ")
                    ) {
                      e.preventDefault();
                      select(r);
                    }
                  }}
                >
                  <td
                    className="receipt-select"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (e.target !== e.currentTarget) return;
                      const input = e.currentTarget.querySelector("input");
                      if (input && !input.disabled) input.click();
                    }}
                  >
                    <label className="receipt-select-hit">
                      <input
                        type="checkbox"
                        aria-label={`영수증 ${number}번 선택`}
                        disabled={busy || analyzing}
                        checked={checkedIds.includes(r.id)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setCheckedIds((ids) =>
                            checked
                              ? [...ids, r.id]
                              : ids.filter((id) => id !== r.id),
                          );
                        }}
                      />
                    </label>
                  </td>
                  <td>{number}</td>
                  <td>
                    <strong>{r.original_name}</strong>
                  </td>
                  <td>
                    {r.transaction_at?.replace("T", " ") || "날짜 확인 필요"}
                  </td>
                  <td>{merchant || "—"}</td>
                  <td className="numeric">
                    {r.final_amount_krw === null
                      ? "—"
                      : `₩ ${won(r.final_amount_krw)}`}
                  </td>
                  <td>
                    {expenses.map((number) => `#${number}`).join(", ") || (
                      <span className="muted">미연결</span>
                    )}
                  </td>
                  <td>
                    <span
                      className="badge receipt-status"
                      data-status={r.ocr_status}
                    >
                      {r.ocr_status}
                    </span>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
        {!!event.receipts.length && !visibleReceipts.length && (
          <div className="empty">조건에 맞는 영수증이 없습니다.</div>
        )}
        {!event.receipts.length && (
          <div className="empty">
            <span className="empty-icon">▧</span>
            <h3>영수증을 한 번에 정리하세요</h3>
            <p>
              영수증 사진을 ZIP으로 묶어 업로드하면 검토와 연결을 시작할 수
              있어요.
            </p>
            <button
              className="primary"
              disabled={busy || analyzing}
              onClick={() => input.current?.click()}
            >
              ZIP 파일 선택
            </button>
          </div>
        )}
      </div>
    </div>
  );
  return (
    <>
      {manager}
      {analysisConfirmation && (
        <Dialog
          title="영수증 분석 시작 확인"
          onClose={() => setAnalysisConfirmation(null)}
        >
          <p>
            선택한 영수증 {analysisConfirmation.length}장의 분석을 시작할까요?
          </p>
          {llm?.enabled && (llm.mode !== "vision" || llm.allow_images) && (
            <p className="alert warning">
              {llm.allow_images && llm.mode !== "text"
                ? "영수증 이미지 또는 추출 텍스트가 외부 AI로 전송될 수 있습니다."
                : "영수증에서 추출한 텍스트가 외부 AI로 전송될 수 있습니다."}{" "}
              API 사용 요금이 발생할 수 있습니다.
            </p>
          )}
          {llm && !llm.enabled && (
            <p className="muted small">
              외부 AI 전송 없이 로컬 OCR로 분석합니다.
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={() => setAnalysisConfirmation(null)}>
              취소
            </button>
            <button
              type="button"
              className="receipt-analysis-action"
              disabled={busy || analyzing}
              onClick={() => {
                setAnalysisConfirmation(null);
                action(async () => {
                  setJob(
                    await api(`/events/${event.id}/receipts/analyze`, "POST", {
                      receipt_ids: analysisConfirmation,
                    }),
                  );
                  setCheckedIds((ids) =>
                    ids.filter((id) => !analysisConfirmation.includes(id)),
                  );
                });
              }}
            >
              분석 시작
            </button>
          </div>
        </Dialog>
      )}
      {editing && (
        <Dialog wide title="영수증 검토" onClose={closeReview}>
          <div className="detail-body receipt-editor">
            <div className="image-preview">
              <h3>
                원본 미리보기 <small>{editing.original_name}</small>
              </h3>
              <a
                href={`/api/receipts/${editing.id}/image`}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  src={`/api/receipts/${editing.id}/image`}
                  alt={`${editing.original_name} 영수증 원본`}
                />
              </a>
              <details>
                <summary>OCR 추출 텍스트</summary>
                <pre>
                  {editing.ocr_text || "아직 추출된 텍스트가 없습니다."}
                </pre>
              </details>
            </div>
            <fieldset
              className="grid-fieldset"
              disabled={busy || analyzing || !!readOnlyReason}
            >
              <h3>추출값 검토</h3>
              {readOnlyReason && (
                <p className="small muted">{readOnlyReason}</p>
              )}
              <p className="muted small">
                {excluded
                  ? "제외된 영수증입니다. 다시 쓰려면 제외 해제를 누르세요. 값이 있으면 검토 필요, 없으면 대기로 돌아갑니다."
                  : confirmed
                    ? "확인된 검토값을 수정하려면 재검토를 누르세요."
                    : "원본과 추출값을 확인한 뒤 검토값 확인을 누르세요. 검토 사유는 메모로 남겨둘 수 있습니다."}
              </p>
              <fieldset
                className="grid-fieldset"
                disabled={confirmed || excluded}
              >
                {!!extractions.length && (
                  <details className="extraction-comparison">
                    <summary>
                      분석 이력·현재 값 비교 ({extractions.length}회)
                    </summary>
                    {extractions.map((ex) => {
                      const value = JSON.parse(ex.extracted_json);
                      const usage = JSON.parse(ex.usage_json || "{}");
                      return (
                        <div key={ex.id}>
                          <p className="small muted">
                            {ex.analyzed_at} · {ex.model_name} · {ex.input_kind}
                          </p>
                          <p className="small muted">
                            입력 토큰 {usage.input_tokens ?? "—"} / 출력 토큰{" "}
                            {usage.output_tokens ?? "—"} · 추정 비용{" "}
                            {ex.estimated_cost_usd
                              ? `$${ex.estimated_cost_usd}`
                              : "단가 미설정"}
                          </p>
                          {ex.error_message && (
                            <p className="error-text">{ex.error_message}</p>
                          )}
                          <table>
                            <thead>
                              <tr>
                                <th>필드</th>
                                <th>분석 후보</th>
                                <th>현재 수정값</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(
                                [
                                  "transaction_at",
                                  "merchant",
                                  "final_amount_krw",
                                  "description",
                                ] as const
                              ).map((key) => (
                                <tr key={key}>
                                  <th>
                                    {
                                      {
                                        transaction_at: "거래일시",
                                        merchant: "상호",
                                        final_amount_krw: "결제금액",
                                        description: "사용 내역",
                                      }[key]
                                    }
                                  </th>
                                  <td>{String(value[key] ?? "미확인")}</td>
                                  <td>{String(editing[key] ?? "미확인")}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <button
                            onClick={() => {
                              if (
                                confirm(
                                  "이 분석 후보를 검토폼에 가져올까요? 저장하기 전까지 DB는 변경되지 않습니다.",
                                )
                              )
                                setEditing({ ...editing, ...value });
                            }}
                          >
                            이 후보를 검토폼에 가져오기
                          </button>
                        </div>
                      );
                    })}
                  </details>
                )}
                <label className="field">
                  거래일시
                  <input
                    type="datetime-local"
                    value={editing.transaction_at?.slice(0, 19) || ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        transaction_at: e.target.value || null,
                      })
                    }
                  />
                </label>
                <label className="field small">
                  날짜만 확인된 경우
                  <input
                    aria-label="거래 날짜만 입력"
                    type="date"
                    value={editing.transaction_at?.slice(0, 10) || ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        transaction_at: e.target.value || null,
                      })
                    }
                  />
                  <span className="muted">
                    시간을 모르면 날짜만 저장하세요. 확정 ZIP의 검토 폴더로
                    분리합니다.
                  </span>
                </label>
                <div className="form-row">
                  <label className="field">
                    상호명
                    <input
                      value={editing.merchant}
                      onChange={(e) =>
                        setEditing({ ...editing, merchant: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    최종 결제금액
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={editing.final_amount_krw ?? ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          final_amount_krw:
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
                <label className="field">
                  사용 내역
                  <input
                    value={editing.description}
                    onChange={(e) =>
                      setEditing({ ...editing, description: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  검토 사유
                  <textarea
                    aria-label="검토 사유"
                    value={editing.review_reason}
                    onChange={(e) =>
                      setEditing({ ...editing, review_reason: e.target.value })
                    }
                  />
                </label>
              </fieldset>
              <div className="actions">
                {excluded ? (
                  <button
                    className="primary"
                    disabled={busy || analyzing}
                    onClick={() => {
                      if (
                        !confirm(
                          "이 영수증을 제외에서 해제할까요? 추출값이 있으면 검토 필요, 없으면 대기 상태로 돌아갑니다.",
                        )
                      )
                        return;
                      action(async () => {
                        const restored = await api<Receipt>(
                          `/receipts/${editing.id}/restore`,
                          "POST",
                        );
                        await refresh();
                        inform(
                          `영수증을 ${restored.ocr_status} 상태로 되돌렸습니다.`,
                        );
                      });
                    }}
                  >
                    제외 해제
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={busy || analyzing}
                    onClick={() =>
                      action(async () => {
                        if (confirmed) {
                          await api(`/receipts/${editing.id}/review`, "POST");
                        } else {
                          await api(
                            `/receipts/${editing.id}`,
                            "PATCH",
                            editing,
                          );
                        }
                        await refresh();
                        inform(
                          confirmed
                            ? "영수증을 검토 필요 상태로 되돌렸습니다."
                            : "영수증 검토값을 확인했습니다.",
                        );
                      })
                    }
                  >
                    {confirmed ? "재검토" : "검토값 확인"}
                  </button>
                )}
                <button
                  disabled={confirmed || excluded || !pending || busy}
                  onClick={() =>
                    setEditing({
                      ...event.receipts.find((r) => r.id === editing.id)!,
                    })
                  }
                >
                  검토값 되돌리기
                </button>
                <button
                  disabled={busy || analyzing}
                  className="danger"
                  onClick={() => {
                    if (confirm("이 영수증 원본과 연결을 삭제할까요?"))
                      action(async () => {
                        await api(`/receipts/${editing.id}`, "DELETE");
                        setEditing(null);
                        setSelected(null);
                        reviewTarget?.onClose();
                        await refresh();
                      });
                  }}
                >
                  영수증 삭제
                </button>
                <button
                  disabled={busy || analyzing || excluded || !!links.length}
                  onClick={() =>
                    action(async () => {
                      await api(`/receipts/${editing.id}/exclude`, "POST");
                      await refresh();
                      inform("중복 영수증을 제외했습니다. 원본은 보관합니다.");
                    })
                  }
                >
                  중복 제외
                </button>
              </div>
              <div className="link-section">
                <h3>지출 행 연결</h3>
                <p className="muted small">
                  배분액 합계가 영수증 결제금액을 넘지 않도록 연결합니다.
                </p>
                {suggestions
                  .find((s) => s.receipt_id === selected)
                  ?.candidates.map((c) => {
                    const i = event.expenses.findIndex(
                      (e) => e.id === c.expense_id,
                    );
                    const x = event.expenses[i];
                    if (!x) return null;
                    return (
                      <button
                        key={c.expense_id}
                        className="suggestion"
                        onClick={() => {
                          setExpense(String(c.expense_id));
                          setAllocated(String(x.amount_krw ?? 0));
                        }}
                      >
                        추천 #{i + 1} · {x.expense_date || "날짜 미입력"} ·{" "}
                        {x.item_name} · {c.score}점
                      </button>
                    );
                  })}
                {links.map((l) => {
                  const i = event.expenses.findIndex(
                    (e) => e.id === l.expense_id,
                  );
                  const x = event.expenses[i];
                  return (
                    <div className="existing-link" key={l.expense_id}>
                      <span>
                        #{i + 1} · {x?.expense_date || "날짜 미입력"} ·{" "}
                        {x?.item_name} · ₩ {won(l.allocated_amount_krw)}
                      </span>
                      <button
                        disabled={busy}
                        onClick={() =>
                          action(async () => {
                            await api(
                              `/events/${event.id}/receipt-links/${l.expense_id}/${l.receipt_id}`,
                              "DELETE",
                            );
                            await refresh();
                          })
                        }
                      >
                        연결 해제
                      </button>
                    </div>
                  );
                })}
                <div className="actions wrap">
                  <select
                    aria-label="연결 지출 선택"
                    value={expense}
                    onChange={(e) => setExpense(e.target.value)}
                  >
                    <option value="">연결할 지출 선택</option>
                    {event.expenses.map((x, i) => (
                      <option value={x.id} key={x.id}>
                        #{i + 1} · {x.expense_date || "날짜 미입력"} ·{" "}
                        {x.item_name} (₩ {won(x.amount_krw)})
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="배분금액"
                    type="number"
                    min="0"
                    step="1"
                    placeholder="배분금액"
                    value={allocated}
                    onChange={(e) => setAllocated(e.target.value)}
                  />
                  <button
                    disabled={busy || !expense || allocated === ""}
                    onClick={() =>
                      action(async () => {
                        await api(`/events/${event.id}/receipt-links`, "POST", {
                          expense_id: Number(expense),
                          receipt_id: editing.id,
                          allocated_amount_krw: Number(allocated),
                        });
                        await refresh();
                        inform("영수증을 연결했습니다.");
                      })
                    }
                  >
                    연결 확정
                  </button>
                </div>
                <div className="actions wrap">
                  {!hideCategories && (
                    <select
                      aria-label="새 지출 항목"
                      value={newCat}
                      onChange={(e) => setNewCat(e.target.value)}
                    >
                      <option value="">신규 지출 항목 선택</option>
                      {event.categories
                        .filter((c) => c.is_active)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {categoryNames?.[c.id] || c.name}
                          </option>
                        ))}
                    </select>
                  )}
                  <button
                    disabled={busy || !newCat || !!links.length}
                    onClick={() =>
                      action(async () => {
                        await api(
                          `/receipts/${editing.id}/create-expense?category_id=${newCat}`,
                          "POST",
                        );
                        await refresh();
                        inform("영수증으로 새 지출을 만들었습니다.");
                      })
                    }
                  >
                    이 영수증으로 지출 생성
                  </button>
                </div>
              </div>
            </fieldset>
          </div>
        </Dialog>
      )}
      {analysisResult && (
        <Dialog
          title={
            analysisResult.status === "completed"
              ? "영수증 분석 완료"
              : "영수증 분석 중단"
          }
          onClose={() => setAnalysisResult(null)}
        >
          <p>
            선택한 영수증 {analysisResult.total}장 중 {analysisResult.processed}
            장을 처리했습니다.
          </p>
          {analysisResult.status !== "completed" ? (
            <p className="alert warning">
              {analysisResult.error_message ||
                "저장된 결과를 확인한 뒤 다시 분석해 주세요."}
            </p>
          ) : (
            <p className="muted">
              분석 오류 {analysisResult.analysis_error_count ?? 0}건 · 영수증별
              결과를 확인해 주세요.
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="primary"
              onClick={() => setAnalysisResult(null)}
            >
              확인
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
