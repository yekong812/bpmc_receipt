"use client";
import { useEffect, useState } from "react";
import { api, download, EventData, won } from "../lib/api";
import { usePptDownload } from "./AppShell";
type Version = {
  version_no: number;
  finalized_at: string;
  finalized_by: string;
  total_krw: number;
  approval_reason: string;
};
type Change = {
  id: number;
  field_name: string;
  old_value: string;
  new_value: string;
  changed_at: string;
  change_source: string;
};
export default function VersionHistory({
  event,
  action,
}: {
  event: EventData;
  action: (fn: () => Promise<void>) => Promise<void>;
}) {
  const downloadPpt = usePptDownload();
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]),
    [changes, setChanges] = useState<Change[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    Promise.all([
      api<Version[]>(`/events/${event.id}/versions`),
      api<Change[]>(`/events/${event.id}/changes`),
    ])
      .then(([v, c]) => {
        setVersions(v);
        setChanges(c);
      })
      .catch((e) => setError(e.message));
  }, [event.id, event.version]);
  return (
    <section>
      <h3>최종 확정 버전</h3>
      <p className="muted small">
        확정 당시 행사·항목·지출·영수증과 배분액을 보관합니다. 재수정 중에도
        이전 확정본을 출력할 수 있습니다.
      </p>
      {error && <p className="error-text">{error}</p>}
      <label className="check-label small">
        <input
          aria-label="이력 PPT 미확인 영수증 포함"
          type="checkbox"
          checked={includeUnknown}
          onChange={(e) => setIncludeUnknown(e.target.checked)}
        />
        이력 PPT에 미확인 영수증 포함
      </label>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>버전</th>
              <th>확정 시각</th>
              <th>확정자</th>
              <th>총지출</th>
              <th>승인 사유</th>
              <th>다운로드</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version_no}>
                <td>v{v.version_no}</td>
                <td>
                  {new Date(v.finalized_at).toLocaleString("ko-KR", {
                    timeZone: "Asia/Seoul",
                  })}
                </td>
                <td>{v.finalized_by}</td>
                <td>₩ {won(v.total_krw)}</td>
                <td>{v.approval_reason || "—"}</td>
                <td>
                  <div className="actions">
                    <button
                      onClick={() =>
                        action(() =>
                          download(
                            `/events/${event.id}/excel/export?version=${v.version_no}`,
                            `${event.name}_v${v.version_no}.xlsx`,
                          ),
                        )
                      }
                    >
                      Excel
                    </button>
                    <button
                      onClick={() =>
                        action(() =>
                          download(
                            `/events/${event.id}/receipts/export-zip?version=${v.version_no}`,
                            `${event.name}_v${v.version_no}_영수증.zip`,
                          ),
                        )
                      }
                    >
                      영수증 ZIP
                    </button>
                    <button
                      onClick={() =>
                        action(() =>
                          downloadPpt(
                            `/events/${event.id}/receipts/export-pptx?version=${v.version_no}&include_unverified=${includeUnknown}`,
                            `${event.name}_v${v.version_no}_영수증증빙자료.pptx`,
                          ),
                        )
                      }
                    >
                      영수증 ppt
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!versions.length && (
          <p className="empty">아직 확정된 버전이 없습니다.</p>
        )}
      </div>
      <h3 style={{ marginTop: 30 }}>
        변경 이력 <small className="muted">최근 200건</small>
      </h3>
      <div className="change-list">
        {changes.map((c) => (
          <details key={c.id}>
            <summary>
              {new Date(c.changed_at).toLocaleString("ko-KR", {
                timeZone: "Asia/Seoul",
              })}{" "}
              · {c.field_name} · {c.change_source}
            </summary>
            <div className="form-row">
              <pre>이전: {c.old_value}</pre>
              <pre>변경: {c.new_value}</pre>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
