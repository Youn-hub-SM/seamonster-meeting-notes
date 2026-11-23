"use client";

// 엑셀 올리기 창 — 인사대장·근무대장·급여가 같이 쓴다. 양식 내려받기 → 파일 고르기 → 미리보기(줄마다 새로·고침·같음·오류) → 등록.
//  등록할 때 서버가 파일을 다시 읽어 다시 대조한다(미리보기 결과를 그대로 저장하지 않는다). 오류가 있는 줄은 넣지 않고 나머지를 넣는다.
//  급여(blockOnError)는 다르다: 오류가 한 줄이라도 있으면 아무것도 넣지 않는다(한 달 급여는 한 묶음으로 저장된다).

import { useEffect, useRef, useState } from "react";
import { useEscClose } from "@/app/lib/use-esc";
import { numText } from "@/app/lib/hr";
import { IMPORT_ACTION_LABEL, type ImportAction, type ImportReport } from "@/app/lib/hr-import";
import { errText, hrApi } from "./api";

const PILL: Record<ImportAction, string> = { create: "hr-pill-ok", update: "", same: "hr-pill-off", error: "hr-pill-bad" };

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    fr.readAsDataURL(file);
  });
}

export default function ExcelImport({
  title, endpoint, extra, unit, applyWord, templateLabel, onTemplate, blockOnError, initialFile, children, onClose, onDone,
}: {
  blockOnError?: boolean;                        // 오류가 있으면 등록 버튼을 막는다(급여)
  initialFile?: File | null;                     // 이미 고른 파일 — 창이 열리자마자 미리보기를 낸다(급여: 버튼을 누르면 바로 파일 고르기가 뜬다)
  title: string;
  endpoint: string;                              // POST { name, file, apply?, …extra }
  extra?: Record<string, unknown>;               // 달·사업장처럼 같이 보낼 값
  unit: string;                                  // "명" | "일"
  applyWord: string;                             // 버튼의 동사: "직원 3명 등록" 의 "등록"
  templateLabel?: string;                        // 양식 내려받기 단추(없으면 보이지 않는다 — 급여는 화면의 [엑셀 내려받기]가 그 양식이다)
  onTemplate?: () => Promise<void>;
  children?: React.ReactNode;                    // 파일 위에 놓을 칸(사업장 고르기 등)
  onClose: () => void;
  onDone: (r: ImportReport) => void;             // 등록이 끝났을 때(목록 다시 읽기)
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [onlyIssues, setOnlyIssues] = useState(false);
  useEscClose(onClose, busy);

  async function send(apply: boolean, picked: File | null = file) {
    if (!picked) { setError("엑셀 파일을 고르세요."); return; }
    setBusy(true); setError("");
    try {
      const r = await hrApi<ImportReport>(endpoint, "POST", { ...(extra || {}), name: picked.name, file: await toBase64(picked), apply });
      setReport(r);
      if (apply) onDone(r);
    } catch (e) { setError(errText(e, "엑셀을 올리지 못했습니다.")); }
    setBusy(false);
  }
  // 파일을 들고 열린 창은 바로 미리보기를 낸다(한 번만)
  const started = useRef(false);
  useEffect(() => {
    if (!initialFile || started.current) return;
    started.current = true;
    send(false, initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);
  async function template() {
    if (!onTemplate) return;
    setBusy(true); setError("");
    try { await onTemplate(); } catch (e) { setError(errText(e, "양식을 내려받지 못했습니다.")); }
    setBusy(false);
  }

  const done = !!report?.applied;
  const todo = report ? report.counts.create + report.counts.update : 0;
  const blocked = !!blockOnError && !!report && report.counts.error > 0;
  const issues = (report?.lines || []).filter((l) => l.errors.length > 0 || l.warns.length > 0);
  const lines = onlyIssues ? issues : report?.lines || [];

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal hr-modal-wide" role="dialog" aria-modal="true" aria-label={title}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">{title}</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기" disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {!done && (
            <div className="hr-import-pick">
              {templateLabel && onTemplate && <button type="button" className="b2b-btn-secondary" onClick={template} disabled={busy}>{templateLabel}</button>}
              <button type="button" className="b2b-btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy}>엑셀 파일 고르기</button>
              <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); setError(""); e.target.value = ""; }} />
              {file && <span className="hr-import-file">{file.name}</span>}
            </div>
          )}
          {!done && children}
          {error && <div className="b2b-error" role="alert">{error}</div>}

          {report && (
            <>
              {done && (
                <div className={report.failed.length > 0 ? "sm-warn" : "sm-success"}>
                  {report.failed.length > 0 ? `일부만 넣었습니다. 넣지 못한 것 ${report.failed.length}건은 아래에 있습니다.` : `엑셀의 내용을 넣었습니다.`}
                </div>
              )}
              {report.failed.length > 0 && (
                <div className="b2b-error" role="alert">넣지 못한 것<ul className="hr-import-list">{report.failed.map((f, i) => <li key={i}>{f}</li>)}</ul></div>
              )}
              <div className="hr-import-counts">
                {(Object.keys(IMPORT_ACTION_LABEL) as ImportAction[]).map((a) => (
                  <span key={a} className={a === "error" && report.counts.error > 0 ? "hr-bad" : ""}>{IMPORT_ACTION_LABEL[a]} <strong>{numText(report.counts[a])}</strong>{a === "error" ? "줄" : unit}</span>
                ))}
                {issues.length > 0 && (
                  <label className="hr-import-only"><input type="checkbox" className="b2b-checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />확인할 줄만 ({issues.length})</label>
                )}
              </div>
              {report.notes.length > 0 && <ul className="hr-import-list hr-rule">{report.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
              {lines.length > 0 && (
                <div className="b2b-table-wrap hr-import-table">
                  <table className="b2b-table">
                    <thead><tr><th>위치</th><th>직원</th><th>처리</th><th>내용</th></tr></thead>
                    <tbody>
                      {lines.map((l, i) => (
                        <tr key={i}>
                          <td>{l.at}</td>
                          <td>{l.who}</td>
                          <td><span className={`b2b-status-pill ${PILL[l.action]}`}>{IMPORT_ACTION_LABEL[l.action]}</span></td>
                          <td className="hr-import-note">
                            {l.errors.map((m, k) => <div key={`e${k}`} className="hr-bad">{m}</div>)}
                            {l.warns.map((m, k) => <div key={`w${k}`}>{m}</div>)}
                            {l.notes.map((m, k) => <div key={`n${k}`} className="sm-muted">{m}</div>)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            {done ? <button type="button" className="b2b-btn-primary" onClick={onClose}>닫기</button> : (
              <>
                <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
                {!report
                  ? <button type="button" className="b2b-btn-primary" onClick={() => send(false)} disabled={busy || !file}>{busy ? "읽는 중..." : "미리보기"}</button>
                  : <button type="button" className="b2b-btn-primary" onClick={() => send(true)} disabled={busy || todo === 0 || blocked}>{busy ? "넣는 중..." : `${numText(todo)}${unit} ${applyWord}`}</button>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
