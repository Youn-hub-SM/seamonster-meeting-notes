"use client";

// 근로소득 간이세액표 — 국세청 원본 엑셀(.xlsx)을 올려 둔다. 급여 계산은 지급일에 유효한 표에서 소득세를 찾는다.
//  표가 없으면 소득세가 자동으로 나오지 않는다(급여 화면에서 직접 넣는다).

import { useCallback, useEffect, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { useEscClose } from "@/app/lib/use-esc";
import { isDate, numText } from "@/app/lib/hr";
import { HrApiError, errText, hrApi } from "../api";

type TableInfo = { effective_from: string; row_count: number; source: string; uploaded_by: string | null; uploaded_at: string };
type Uploaded = { effective_from: string; row_count: number; sheet: string; first: number[]; last: number[] };
const kstText = (iso: string) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "");

export default function TaxTables() {
  const toast = useToast();
  const confirm = useConfirm();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<Uploaded | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setTables((await hrApi<{ tables: TableInfo[] }>("/api/hr/tax-table")).tables); }
    catch (err) { if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "간이세액표를 불러오지 못했습니다.")); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function remove(t: TableInfo) {
    const ok = await confirm({ title: `${t.effective_from} 간이세액표 삭제`, body: "이 날짜부터의 지급분이 앞 표를 쓰게 됩니다. 이미 확정한 급여는 바뀌지 않습니다.", action: "세액표 삭제" });
    if (!ok) return;
    try {
      await hrApi(`/api/hr/tax-table?effective_from=${t.effective_from}`, "DELETE");
      setTables((p) => p.filter((x) => x.effective_from !== t.effective_from));
      toast.success("간이세액표를 삭제했습니다");
    } catch (err) { toast.error(errText(err, "간이세액표를 지우지 못했습니다.")); }
  }

  return (
    <section className="hr-sec">
      <div className="hr-sec-head">
        <h2>간이세액표</h2>
        <button type="button" className="b2b-btn-secondary" disabled={loading || !!error} onClick={() => setOpen(true)}>간이세액표 올리기</button>
      </div>
      {error && <div className="b2b-error" role="alert">{error}</div>}
      {last && (
        <div className="sm-success">
          {last.effective_from} 표 {numText(last.row_count)}줄을 올렸습니다. 첫 줄 {numText(last.first[0])}원 이상 {numText(last.first[1])}원 미만, 마지막 줄 {numText(last.last[0])}원(가족 1명 세액 {numText(last.last[2])}원) — 원본과 맞는지 확인하세요.
        </div>
      )}
      {loading ? <div className="b2b-loading">불러오는 중...</div> : error ? null : tables.length === 0 ? (
        <div className="b2b-empty">
          올려 둔 간이세액표가 없습니다.
          <div className="b2b-empty-action"><button type="button" className="b2b-btn-secondary" onClick={() => setOpen(true)}>간이세액표 올리기</button></div>
        </div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table hr-table">
            <thead><tr><th>적용 시작일(지급일)</th><th className="num">줄 수</th><th>올린 파일</th><th>올린 사람</th><th>올린 때</th><th></th></tr></thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.effective_from}>
                  <td>{t.effective_from}</td>
                  <td className="num">{numText(t.row_count)}</td>
                  <td>{t.source}</td>
                  <td>{t.uploaded_by || ""}</td>
                  <td>{kstText(t.uploaded_at)}</td>
                  <td className="actions"><button type="button" className="b2b-link-btn" onClick={() => remove(t)}>세액표 삭제</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <UploadForm onClose={() => setOpen(false)} onDone={(u) => { setOpen(false); setLast(u); load(); }} />}
    </section>
  );
}

function UploadForm({ onClose, onDone }: { onClose: () => void; onDone: (u: Uploaded) => void }) {
  const [from, setFrom] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  useEscClose(onClose, busy);

  async function upload() {
    const errs: Record<string, string> = {};
    if (!isDate(from)) errs.effective_from = "적용 시작일을 입력하세요";
    if (!file) errs.file = "엑셀 파일을 고르세요";
    if (Object.keys(errs).length > 0) { setErrors(errs); setFormError("입력을 확인하세요."); return; }
    setBusy(true); setFormError(""); setErrors({});
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
        fr.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
        fr.readAsDataURL(file as File);
      });
      onDone(await hrApi<Uploaded>("/api/hr/tax-table", "POST", { effective_from: from, name: (file as File).name, file: b64 }));
    } catch (e) {
      if (e instanceof HrApiError) { setErrors(e.fields); setFormError(e.message); } else setFormError(errText(e, "간이세액표를 올리지 못했습니다."));
      setBusy(false);
    }
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal hr-modal-mid" role="dialog" aria-modal="true" aria-label="간이세액표 올리기">
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">간이세액표 올리기</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기" disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {formError && <div className="b2b-error" role="alert">{formError}</div>}
          <div className="hr-form">
            <section className="hr-form-sec">
              <label className="b2b-field">
                <span className="b2b-field-label">적용 시작일(지급일)<span className="req">*</span></span>
                <input className="b2b-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-invalid={errors.effective_from ? "true" : undefined} />
                {errors.effective_from && <span className="b2b-field-error">{errors.effective_from}</span>}
              </label>
              <label className="b2b-field hr-span2">
                <span className="b2b-field-label">국세청 근로소득 간이세액표 엑셀(.xlsx)<span className="req">*</span></span>
                <input className="b2b-input" type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] || null)} aria-invalid={errors.file ? "true" : undefined} />
                {errors.file && <span className="b2b-field-error">{errors.file}</span>}
              </label>
            </section>
          </div>
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
            <button type="button" className="b2b-btn-primary" onClick={upload} disabled={busy}>{busy ? "올리는 중..." : "간이세액표 올리기"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
