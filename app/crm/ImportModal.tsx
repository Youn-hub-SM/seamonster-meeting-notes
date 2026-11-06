"use client";

// CRM 메시지 엑셀 가져오기 모달(2026-11-06) — 양식 내려받기 → 파일 선택 → 미리보기(줄별 처리·오류·경고·보정) → 등록.
//  서버: /api/crm/import-xlsx (app/lib/crm-import.ts). 같은 메시지명은 덮어쓰고, '전부 지우고 새로' 는 체크했을 때만.
import { useRef, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";

type RowReport = { row: number; title: string; stage: string; action: "insert" | "update" | "skip"; errors: string[]; warnings: string[]; fixes: string[] };
type Preview = { rows: RowReport[]; counts: { insert: number; update: number; skip: number }; newStages: string[]; newOptions: { channels: { label: string }[]; customers: { label: string }[]; msgTypes: { label: string }[] }; existing: number };
type Result = { inserted: number; updated: number; deleted: number; skipped: number; failed: string[] };

const ACTION_LABEL: Record<RowReport["action"], string> = { insert: "새로 등록", update: "덮어쓰기", skip: "건너뜀" };

export default function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [onlyIssues, setOnlyIssues] = useState(false);

  async function send(apply: boolean) {
    if (!file) { setError("엑셀 파일을 고르세요"); return; }
    setBusy(true); setError("");
    try {
      const fd = new FormData();
      fd.append("file", file); fd.append("replace", replace ? "1" : "0"); fd.append("apply", apply ? "1" : "0");
      const r = await fetch("/api/crm/import-xlsx", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "가져오지 못했습니다. 파일을 확인하세요");
      if (apply) { setResult(j); toast.success(`메시지 ${j.inserted + j.updated}건을 등록했습니다`); onDone(); }
      else setPreview(j);
    } catch (e) { setError(e instanceof Error ? e.message : "가져오지 못했습니다. 파일을 확인하세요"); }
    setBusy(false);
  }
  async function applyNow() {
    if (!preview) return;
    const n = preview.counts.insert + preview.counts.update;
    const body = replace
      ? `기존 메시지 ${preview.existing}건을 전부 지우고 파일의 ${n}건을 새로 등록합니다. 되돌릴 수 없습니다.`
      : `새로 ${preview.counts.insert}건, 같은 이름 덮어쓰기 ${preview.counts.update}건을 등록합니다.${preview.counts.skip ? ` 건너뛰는 줄 ${preview.counts.skip}건.` : ""}`;
    if (!(await confirm({ title: replace ? "전부 지우고 새로 등록" : "메시지 등록", body, action: replace ? "지우고 등록" : "메시지 등록", danger: replace }))) return;
    await send(true);
  }
  const rows = (preview?.rows ?? []).filter((r) => !onlyIssues || r.errors.length || r.warnings.length || r.fixes.length);
  const issueCount = (preview?.rows ?? []).filter((r) => r.errors.length || r.warnings.length || r.fixes.length).length;

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal crm-import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head"><h2 className="b2b-modal-title">엑셀로 메시지 가져오기</h2><button className="b2b-modal-close" aria-label="닫기" onClick={onClose}>✕</button></div>
        <div className="b2b-modal-body">
          {result ? (
            <div>
              <div className="sm-success">등록 완료 — 새로 {result.inserted}건, 덮어쓰기 {result.updated}건{result.deleted ? `, 지움 ${result.deleted}건` : ""}{result.skipped ? `, 건너뜀 ${result.skipped}건` : ""}</div>
              {result.failed.length > 0 && <div className="b2b-error" style={{ marginTop: 8 }}>저장하지 못한 줄<ul>{result.failed.map((f, i) => <li key={i}>{f}</li>)}</ul></div>}
            </div>
          ) : (
            <>
              <div className="sm-row-wrap" style={{ gap: 8, alignItems: "center", marginBottom: 12 }}>
                <a className="b2b-btn-secondary" href="/templates/crm-messages-template.xlsx">양식 내려받기</a>
                <button className="b2b-btn-secondary" onClick={() => fileRef.current?.click()}>엑셀 파일 고르기</button>
                <input ref={fileRef} type="file" accept=".xlsx" style={{ display: "none" }} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); e.target.value = ""; }} />
                {file && <span className="sm-faint" style={{ fontSize: 12 }}>{file.name}</span>}
              </div>
              <label className="b2b-checkbox" style={{ marginBottom: 12 }}>
                <input type="checkbox" checked={replace} onChange={(e) => { setReplace(e.target.checked); setPreview(null); }} /> 기존 메시지를 전부 지우고 파일 내용으로 새로 등록
              </label>
              {error && <div className="b2b-error" style={{ marginBottom: 10 }}>{error}</div>}
              {preview && (
                <>
                  <div className="sm-row-wrap" style={{ gap: 12, alignItems: "center", marginBottom: 8, fontSize: 13 }}>
                    <span>새로 등록 <strong>{preview.counts.insert}</strong></span>
                    <span>덮어쓰기 <strong>{preview.counts.update}</strong></span>
                    <span>건너뜀 <strong>{preview.counts.skip}</strong></span>
                    {replace && <span>지움 <strong>{preview.existing}</strong></span>}
                    {issueCount > 0 && <label className="b2b-checkbox" style={{ marginLeft: "auto" }}><input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> 문제 있는 줄만 ({issueCount})</label>}
                  </div>
                  {(preview.newStages.length > 0 || preview.newOptions.channels.length > 0 || preview.newOptions.customers.length > 0 || preview.newOptions.msgTypes.length > 0) && (
                    <div className="sm-warn" style={{ marginBottom: 8 }}>
                      {preview.newStages.length > 0 && <div>새 단계: {preview.newStages.join(", ")}</div>}
                      {preview.newOptions.channels.length > 0 && <div>선택지에 더해질 발송 수단: {preview.newOptions.channels.map((o) => o.label).join(", ")}</div>}
                      {preview.newOptions.customers.length > 0 && <div>선택지에 더해질 고객군: {preview.newOptions.customers.map((o) => o.label).join(", ")}</div>}
                      {preview.newOptions.msgTypes.length > 0 && <div>선택지에 더해질 유형: {preview.newOptions.msgTypes.map((o) => o.label).join(", ")}</div>}
                    </div>
                  )}
                  <div className="b2b-table-wrap" style={{ flexShrink: 0, maxHeight: 360, overflow: "auto" }}>
                    <table className="b2b-table is-compact">
                      <thead><tr><th>행</th><th>단계</th><th>메시지명</th><th>처리</th><th>확인할 것</th></tr></thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.row}>
                            <td className="num">{r.row}</td>
                            <td>{r.stage}</td>
                            <td>{r.title || <span className="sm-faint">(이름 없음)</span>}</td>
                            <td><span className={`b2b-status-pill${r.action === "skip" ? " is-danger" : ""}`}>{ACTION_LABEL[r.action]}</span></td>
                            <td style={{ whiteSpace: "normal", fontSize: 12 }}>
                              {r.errors.map((m, i) => <div key={`e${i}`} style={{ color: "var(--sm-danger)" }}>{m}</div>)}
                              {r.warnings.map((m, i) => <div key={`w${i}`}>{m}</div>)}
                              {r.fixes.map((m, i) => <div key={`f${i}`} className="sm-faint">보정: {m}</div>)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <div className="b2b-modal-foot"><span />
          <div className="b2b-modal-foot-right">
            {result ? <button className="b2b-btn-primary" onClick={onClose}>닫기</button> : (
              <>
                <button className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
                {!preview ? (
                  <button className="b2b-btn-primary" onClick={() => send(false)} disabled={busy || !file}>{busy ? "읽는 중..." : "미리보기"}</button>
                ) : (
                  <button className="b2b-btn-primary" onClick={applyNow} disabled={busy || preview.counts.insert + preview.counts.update === 0}>{busy ? "등록 중..." : `메시지 ${preview.counts.insert + preview.counts.update}건 등록`}</button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
