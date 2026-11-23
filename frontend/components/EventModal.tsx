"use client";
import { useCallback, useEffect, useState } from "react";
import { api, download, EventData, Expense, won } from "../lib/api";
import { statusClass } from "../lib/ui";
type Tab = "expenses" | "receipts" | "categories" | "history";

import { usePptDownload, useWorkspaceDirty } from "./AppShell";
import SaveNotice from "./SaveNotice";
import EventForm from "./EventForm";
import CategoryManager from "./CategoryManager";
import ExcelImport from "./ExcelImport";
import ReceiptManager from "./ReceiptManager";
import FinalizeDialog from "./FinalizeDialog";
import VersionHistory from "./VersionHistory";
export default function EventModal({
  initial,
  events,
  onClose,
  onChanged,
  inform,
  importOnOpen,
}: {
  initial: EventData;
  events: EventData[];
  onClose: () => void;
  onChanged: () => void;
  inform: (s: string) => void;
  importOnOpen: boolean;
}) {
  const downloadPpt = usePptDownload();
  const setWorkspaceDirty = useWorkspaceDirty();
  const [event, setEvent] = useState(initial),
    [draft, setDraft] = useState<Expense[]>(initial.expenses),
    [tab, setTab] = useState<Tab>(
      initial.expenses.length || importOnOpen ? "expenses" : "receipts",
    ),
    [error, setError] = useState(""),
    [saveNotice, setSaveNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [importing, setImporting] = useState(importOnOpen),
    [editing, setEditing] = useState(false),
    [selected, setSelected] = useState<number[]>([]),
    [finalizing, setFinalizing] = useState(false),
    [focusedExpense, setFocusedExpense] = useState<number | null>(null),
    [childDirty, setChildDirty] = useState(false),
    [reviewReceiptId, setReviewReceiptId] = useState<number | null>(null),
    [includeUnknown, setIncludeUnknown] = useState(false),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const locked = event.status === "최종 확정";
  const expenseDirty = JSON.stringify(draft) !== JSON.stringify(event.expenses);
  const dirty = expenseDirty || childDirty;
  const close = useCallback(() => {
    if (!dirty || confirm("저장하지 않은 지출 변경사항을 버리고 닫을까요?"))
      onClose();
  }, [dirty, onClose]);
  const refresh = useCallback(async () => {
    const e = await api<EventData>(`/events/${event.id}`);
    setEvent(e);
    setDraft(e.expenses);
    setSelected([]);
    onChanged();
  }, [event.id, onChanged]);
  useEffect(() => {
    setWorkspaceDirty(dirty);
    return () => setWorkspaceDirty(false);
  }, [dirty, setWorkspaceDirty]);
  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", fn);
    return () => window.removeEventListener("beforeunload", fn);
  }, [dirty]);
  async function action(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (childDirty)
      throw new Error(
        "현재 탭의 검토값·항목 저장 버튼으로 변경사항을 먼저 저장해주세요.",
      );
    const e = await api<EventData>(`/events/${event.id}/draft/save`, "POST", {
      version: event.version,
      expenses: draft,
    });
    setEvent(e);
    setDraft(e.expenses);
    setSelected([]);
    onChanged();
    inform("지출내역을 임시 저장했습니다.");
  }
  function guard(fn: () => void) {
    if (dirty) {
      setSaveNotice(
        childDirty
          ? tab === "receipts"
            ? "저장하지 않은 영수증 검토값이 있습니다. 검토 팝업에서 ‘검토값 확인’을 누른 뒤 이동해 주세요."
            : "저장하지 않은 항목 변경사항이 있습니다. 수정한 항목의 ‘저장’을 누른 뒤 이동해 주세요."
          : "저장하지 않은 지출 변경사항이 있습니다. 목록 위 오른쪽의 ‘임시 저장’을 누른 뒤 이동해 주세요.",
      );
      return;
    }
    fn();
  }
  async function exportFile(type: "excel" | "pptx" | "zip") {
    const params = new URLSearchParams();
    if (!event.latest_final_version) params.set("draft", "true");
    if (type !== "excel") {
      if (from) params.set("from", from);
      if (to) params.set("to", to);
    }
    if (type === "pptx" && includeUnknown)
      params.set("include_unverified", "true");
    const path = type === "excel" ? "excel/export" : `receipts/export-${type}`;
    const suffix = {
      excel: "지출내역.xlsx",
      pptx: "영수증증빙자료.pptx",
      zip: "영수증.zip",
    }[type];
    const downloadFile = type === "pptx" ? downloadPpt : download;
    await downloadFile(
      `/events/${event.id}/${path}?${params}`,
      `${event.latest_final_version ? "" : "DRAFT_"}${event.name}_${suffix}`,
    );
  }
  const total = draft.reduce((a, e) => a + Number(e.amount_krw || 0), 0);
  const update = (i: number, key: keyof Expense, value: unknown) =>
    setDraft(draft.map((x, n) => (n === i ? { ...x, [key]: value } : x)));
  const activeCats = event.categories.filter((c) => c.is_active);
  return (
    <section className="event-page" aria-label="지출내역(구매LIST)">
      <div className="dialog-heading">
        <h2>지출내역(구매LIST)</h2>
        <button aria-label="닫기" onClick={close}>
          ×
        </button>
      </div>
      <div className="detail-top">
        <div>
          <h2>
            {event.name}{" "}
            <button
              className="text-button small"
              disabled={locked}
              onClick={() => guard(() => setEditing(true))}
            >
              정보 수정 ↗
            </button>
          </h2>
          <p className="muted small">
            행사 날짜 {event.event_date?.replaceAll("-", ".")} · 관리기간{" "}
            {event.start_date.replaceAll("-", ".")} —{" "}
            {event.end_date.replaceAll("-", ".")}{" "}
            <span className={`badge ${statusClass(event.status)}`}>
              {event.status}
            </span>
          </p>
        </div>
        <div className="total-box">
          <span>총지출</span>
          <strong>₩ {won(total)}</strong>
        </div>
      </div>
      <div className="workflow-banner">
        <span>영수증 업로드 → 지출 초안 작성 → 임시 저장 → 최종 확정</span>
        <b>
          {event.latest_final_version
            ? `최근 확정본 v${event.latest_final_version}`
            : "아직 확정되지 않은 초안"}
        </b>
      </div>
      <div className="tabs" role="tablist">
        {(
          [
            ["expenses", "지출내역", draft.length],
            ["receipts", "영수증 관리", event.receipts.length],
            ["categories", "항목 관리", event.categories.length],
            ["history", "변경 이력", event.latest_final_version],
          ] as const
        ).map(([id, label, n]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => id !== tab && guard(() => setTab(id))}
          >
            {label}
            <span>{n}</span>
          </button>
        ))}
      </div>
      <div className="record-actions" role="group" aria-label="저장 및 확정">
        <span className={dirty ? "warning-text" : "muted"}>
          {dirty
            ? childDirty
              ? "● 현재 탭의 검토값·항목 저장 버튼으로 저장해주세요."
              : "● 저장하지 않은 변경사항이 있습니다."
            : "✓ 모든 변경사항이 저장되어 있습니다."}
        </span>
        <div className="actions wrap">
          {locked ? (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await api(`/events/${event.id}/reopen`, "POST", {
                    version: event.version,
                  });
                  await refresh();
                  inform("확정본을 보존하고 재수정 초안을 열었습니다.");
                })
              }
            >
              수정 재오픈
            </button>
          ) : (
            <>
              <button
                disabled={!expenseDirty || childDirty || busy}
                onClick={() => {
                  if (confirm("지출 변경사항을 취소할까요?")) {
                    setDraft(event.expenses);
                    setSelected([]);
                  }
                }}
              >
                변경 취소
              </button>
              <button
                disabled={!expenseDirty || childDirty || busy}
                className="primary"
                onClick={() => action(save)}
              >
                {busy ? "처리 중…" : "임시 저장"}
              </button>
              <button
                disabled={busy || dirty}
                onClick={() => setFinalizing(true)}
              >
                최종 확정
              </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
          <button onClick={() => setError("")}>닫기</button>
        </div>
      )}
      <div className="detail-body">
        <div className="toolbar export-toolbar">
          <div className="actions wrap">
            <label className="small">
              출력 시작
              <input
                aria-label="출력 시작일"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="small">
              종료
              <input
                aria-label="출력 종료일"
                type="date"
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
              disabled={busy || locked || tab !== "expenses"}
              onClick={() => guard(() => setImporting(true))}
            >
              ↥ Excel 장부 업로드
            </button>
            <button
              disabled={busy}
              onClick={() => guard(() => action(() => exportFile("excel")))}
            >
              ↧ Excel
            </button>
            <button
              disabled={busy}
              onClick={() => guard(() => action(() => exportFile("pptx")))}
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
        {tab === "expenses" && (
          <>
            <div className="toolbar">
              <div className="actions wrap">
                <button
                  className="primary"
                  disabled={locked || !activeCats.length || busy}
                  onClick={() =>
                    setDraft([
                      ...draft,
                      {
                        category_id: activeCats[0].id,
                        expense_date: event.start_date,
                        item_name: "",
                        amount_krw: 0,
                        vendor: "",
                        purchased: false,
                        sort_order: draft.length,
                        note: "",
                      },
                    ])
                  }
                >
                  ＋ 행 추가
                </button>
                <button
                  className="delete-action"
                  disabled={locked || !selected.length || busy}
                  onClick={() => {
                    if (
                      !confirm(
                        "선택한 지출 행을 삭제할까요? 변경 이력에 기록됩니다.",
                      )
                    )
                      return;
                    setDraft(draft.filter((_, i) => !selected.includes(i)));
                    setSelected([]);
                  }}
                >
                  선택 삭제 {selected.length || ""}
                </button>
                <button
                  className="review"
                  disabled={
                    locked ||
                    busy ||
                    !selected.some(
                      (i) => draft[i]?.review_status === "검토 필요",
                    )
                  }
                  onClick={() =>
                    setDraft(
                      draft.map((row, i) =>
                        selected.includes(i) &&
                        row.review_status === "검토 필요"
                          ? { ...row, review_status: "확인됨" }
                          : row,
                      ),
                    )
                  }
                >
                  일괄 검토
                </button>
              </div>
            </div>
            <div className="expense-layout">
              <fieldset disabled={locked} className="grid-fieldset">
                <div className="table-scroll expense-scroll">
                  <table className="expense-table">
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            aria-label="전체 행 선택"
                            checked={
                              draft.length > 0 &&
                              selected.length === draft.length
                            }
                            onChange={(e) =>
                              setSelected(
                                e.target.checked ? draft.map((_, i) => i) : [],
                              )
                            }
                          />
                        </th>
                        {[
                          "No.",
                          "지출일",
                          "항목",
                          "품목",
                          "총계",
                          "구매처",
                          "영수증 No.",
                          "영수증 총합",
                          "구매 여부",
                          "차액 사유 / 메모",
                          "검토 완료",
                          "관리",
                        ].map((x) => (
                          <th key={x}>{x}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {draft.map((x, i) => {
                        const links = event.links.filter(
                          (l) => l.expense_id === x.id,
                        );
                        const sum = links.reduce(
                          (a, l) => a + (l.allocated_amount_krw || 0),
                          0,
                        );
                        const cat = event.categories.find(
                          (c) => c.id === x.category_id,
                        );
                        const mismatch =
                          links.length > 0 && sum !== Number(x.amount_krw);
                        return (
                          <tr
                            key={x.id || `new-${i}`}
                            onClick={() => setFocusedExpense(i)}
                          >
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`${i + 1}행 선택`}
                                checked={selected.includes(i)}
                                onChange={(e) =>
                                  setSelected(
                                    e.target.checked
                                      ? [...selected, i]
                                      : selected.filter((n) => n !== i),
                                  )
                                }
                              />
                            </td>
                            <td className="muted">{i + 1}</td>
                            <td>
                              <input
                                aria-label={`${i + 1}행 지출일`}
                                required
                                type="date"
                                value={x.expense_date || ""}
                                onChange={(e) =>
                                  update(i, "expense_date", e.target.value)
                                }
                              />
                            </td>
                            <td>
                              <select
                                aria-label={`${i + 1}행 항목`}
                                style={{ backgroundColor: cat?.color }}
                                value={x.category_id ?? ""}
                                onChange={(e) =>
                                  update(
                                    i,
                                    "category_id",
                                    Number(e.target.value),
                                  )
                                }
                              >
                                {event.categories
                                  .filter(
                                    (c) =>
                                      c.is_active || c.id === x.category_id,
                                  )
                                  .map((c) => (
                                    <option key={c.id} value={c.id}>
                                      {c.name}
                                      {c.is_active ? "" : " (비활성)"}
                                    </option>
                                  ))}
                              </select>
                            </td>
                            <td>
                              <input
                                aria-label={`${i + 1}행 품목`}
                                value={x.item_name}
                                placeholder="품목 입력"
                                maxLength={500}
                                onChange={(e) =>
                                  update(i, "item_name", e.target.value)
                                }
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`${i + 1}행 총계`}
                                className="numeric"
                                type="number"
                                min="0"
                                step="1"
                                max={10 ** 12}
                                value={x.amount_krw ?? ""}
                                onChange={(e) =>
                                  update(
                                    i,
                                    "amount_krw",
                                    e.target.value === ""
                                      ? null
                                      : Number(e.target.value),
                                  )
                                }
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`${i + 1}행 구매처`}
                                value={x.vendor}
                                placeholder="구매처"
                                onChange={(e) =>
                                  update(i, "vendor", e.target.value)
                                }
                              />
                            </td>
                            <td className="small">
                              {links.map((l) => {
                                const index = event.receipts.findIndex(
                                  (r) => r.id === l.receipt_id,
                                );
                                const receipt = event.receipts[index];
                                if (!receipt) return null;
                                return (
                                  <a
                                    key={receipt.id}
                                    className="text-button"
                                    href={`/api/receipts/${receipt.id}/image`}
                                    aria-haspopup="dialog"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      setReviewReceiptId(receipt.id);
                                    }}
                                  >
                                    #{receipt.receipt_number || index + 1}
                                  </a>
                                );
                              })}
                              {!links.length && (
                                <span className="muted">미연결</span>
                              )}
                            </td>
                            <td
                              className={`numeric ${mismatch ? "warning-text" : ""}`}
                              title={
                                mismatch
                                  ? "지출금액과 영수증 배분액이 다릅니다. 사유를 메모하세요."
                                  : ""
                              }
                            >
                              {links.length
                                ? `${mismatch ? "⚠ " : ""}₩ ${won(sum)}`
                                : "—"}
                            </td>
                            <td className="center">
                              <input
                                aria-label={`${i + 1}행 구매 여부`}
                                type="checkbox"
                                checked={x.purchased}
                                onChange={(e) =>
                                  update(i, "purchased", e.target.checked)
                                }
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`${i + 1}행 메모`}
                                value={x.note}
                                placeholder={
                                  mismatch ? "차액 사유 입력" : "메모"
                                }
                                onChange={(e) =>
                                  update(i, "note", e.target.value)
                                }
                              />
                            </td>
                            <td className="center">
                              <input
                                type="checkbox"
                                aria-label={`${i + 1}행 검토 완료`}
                                checked={x.review_status !== "검토 필요"}
                                onChange={(e) =>
                                  update(
                                    i,
                                    "review_status",
                                    e.target.checked ? "확인됨" : "검토 필요",
                                  )
                                }
                              />
                              <small className="muted">
                                {x.source_type === "ocr"
                                  ? "OCR 초안"
                                  : x.source_type === "llm"
                                    ? "LLM 초안"
                                    : ""}
                              </small>
                            </td>
                            <td>
                              <button
                                className="text-button"
                                title="행 복제"
                                onClick={() => {
                                  const copy = { ...x };
                                  delete copy.id;
                                  setDraft([...draft, copy]);
                                }}
                              >
                                ⧉
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!draft.length && (
                    <div className="empty">
                      <h3>아직 지출내역이 없습니다.</h3>
                      <p>행을 추가하거나 Excel 파일을 가져와 시작하세요.</p>
                    </div>
                  )}
                </div>
              </fieldset>
              <div className="summary-column">
                <aside className="summary">
                  <p className="eyebrow">EXPENSE SUMMARY</p>
                  <h3>항목별 총계</h3>
                  {event.categories.map((c) => (
                    <div key={c.id}>
                      <span>
                        <i style={{ background: c.color }} />
                        {c.name}
                      </span>
                      <strong>
                        ₩{" "}
                        {won(
                          draft
                            .filter((x) => x.category_id === c.id)
                            .reduce((a, x) => a + Number(x.amount_krw), 0),
                        )}
                      </strong>
                    </div>
                  ))}
                  <div className="summary-total">
                    <span>합계</span>
                    <strong>₩ {won(total)}</strong>
                  </div>
                  <p className="muted small">
                    구매 여부와 관계없이
                    <br />
                    모든 지출을 합산합니다.
                  </p>
                </aside>
                {focusedExpense !== null && draft[focusedExpense] && (
                  <div className="expense-receipt-preview">
                    <h3>#{focusedExpense + 1} 영수증 원본</h3>
                    <p className="small muted">
                      현재 품목: {draft[focusedExpense].item_name || "미입력"} ·
                      ₩ {won(draft[focusedExpense].amount_krw)}
                    </p>
                    {event.links
                      .filter((l) => l.expense_id === draft[focusedExpense].id)
                      .map((l) => {
                        const r = event.receipts.find(
                          (r) => r.id === l.receipt_id,
                        );
                        return (
                          r && (
                            <div key={r.id}>
                              <a
                                href={`/api/receipts/${r.id}/image`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <img
                                  src={`/api/receipts/${r.id}/image`}
                                  alt={r.original_name}
                                />
                              </a>
                              <p className="small">
                                {r.merchant} · ₩ {won(r.final_amount_krw)}
                              </p>
                              <details>
                                <summary>OCR 원문</summary>
                                <pre>
                                  {r.ocr_text || "추출 원문이 없습니다."}
                                </pre>
                              </details>
                            </div>
                          )
                        );
                      })}
                    <button
                      className="text-button"
                      onClick={() => guard(() => setTab("receipts"))}
                    >
                      영수증 연결·배분 수정 ↗
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
        {tab === "categories" && (
          <fieldset disabled={locked} className="grid-fieldset">
            <CategoryManager
              onDirtyChange={setChildDirty}
              event={event}
              events={events}
              refresh={refresh}
              action={action}
              busy={busy || locked}
            />
          </fieldset>
        )}
        {(tab === "receipts" || reviewReceiptId !== null) && (
          <ReceiptManager
            key={reviewReceiptId ?? "list"}
            onDirtyChange={setChildDirty}
            event={event}
            refresh={refresh}
            action={action}
            busy={busy || locked}
            inform={inform}
            reviewTarget={
              reviewReceiptId === null
                ? undefined
                : {
                    id: reviewReceiptId,
                    onClose: () => setReviewReceiptId(null),
                  }
            }
            readOnlyReason={
              reviewReceiptId !== null && expenseDirty
                ? "영수증을 수정하려면 지출 변경사항을 먼저 저장하세요."
                : undefined
            }
          />
        )}
        {tab === "history" && <VersionHistory event={event} action={action} />}
      </div>
      <footer className="modal-footer">
        <div className="actions wrap">
          <button
            disabled={busy}
            onClick={() =>
              action(async () => {
                if (dirty) await save();
                onClose();
              })
            }
          >
            {locked ? "목록으로" : "저장 후 목록"}
          </button>
        </div>
      </footer>
      {saveNotice && (
        <SaveNotice message={saveNotice} onClose={() => setSaveNotice("")} />
      )}
      {finalizing && (
        <FinalizeDialog
          event={event}
          onClose={() => setFinalizing(false)}
          onDone={async () => {
            setFinalizing(false);
            await refresh();
            inform("최종 확정본을 보관했습니다.");
          }}
        />
      )}
      {importing && (
        <ExcelImport
          event={event}
          onClose={() => setImporting(false)}
          onDone={async () => {
            setImporting(false);
            await refresh();
            inform("Excel 지출내역을 반영했습니다.");
          }}
        />
      )}
      {editing && (
        <EventForm
          event={event}
          onClose={() => setEditing(false)}
          onSubmit={async (data) => {
            await api(`/events/${event.id}`, "PATCH", data);
            setEditing(false);
            await refresh();
          }}
        />
      )}
    </section>
  );
}
