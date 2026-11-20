"use client";

// 파도소리 거래처 — 매출처·매입처 목록(2026-11-20 대표 지시: 씨몬스터 거래처와 같은 칸). 모든 계정이 보고 등록·수정한다.
//  기록 창의 거래처 칸이 이 목록을 보여 주고, 기록에 새로 적은 이름은 저장할 때 이 목록에 자동으로 들어온다.
//  삭제·[기록에서 모으기]·[회사 정보](출고증에 찍히는 상호·대표·전화·팩스·로고·직인)는 관리자만.

import { useCallback, useEffect, useMemo, useState } from "react";
import { matchKoQuery, hangulInputValue } from "@/app/lib/hangul";
import { useEscClose } from "@/app/lib/use-esc";
import { EMPTY_COMPANY, EMPTY_PARTNER, MAX_IMAGE_CHARS, PARTNER_KINDS, formatBizNo, type FactoryCompany, type FactoryPartner, type PartnerInput, type PartnerKind } from "@/app/lib/factory-partners";

const FILTERS = ["전체", "매출처", "매입처"] as const;
type Filter = (typeof FILTERS)[number];

export default function FactoryPartnersPage() {
  const [rows, setRows] = useState<FactoryPartner[]>([]);
  const [admin, setAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [kw, setKw] = useState("");
  const [filter, setFilter] = useState<Filter>("전체");
  const [edit, setEdit] = useState<FactoryPartner | "new" | null>(null);
  const [company, setCompany] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/factory/partners", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.partners || []); setAdmin(!!j.admin);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 실패"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const q = kw.trim();
    return rows
      .filter((r) => filter === "전체" || r.kind === filter || r.kind === "둘 다")
      .filter((r) => !q || matchKoQuery(`${r.name} ${r.biz_no || ""} ${r.ceo_name || ""} ${r.contact_name || ""} ${r.contact_phone || ""} ${r.memo || ""}`, q));
  }, [rows, kw, filter]);

  async function collect() {
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch("/api/factory/partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ collect: true }) });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || "모으기 실패");
      setNotice(j.added ? `기록에서 거래처 ${j.added}곳을 모아 등록했습니다.` : "새로 모을 거래처가 없습니다.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "모으기 실패"); }
    setBusy(false);
  }

  async function remove(p: FactoryPartner) {
    if (!confirm(`${p.name}을(를) 목록에서 지울까요?\n기록에 적힌 거래처 이름은 그대로 남습니다.`)) return;
    setError(""); setNotice("");
    try {
      const j = await (await fetch(`/api/factory/partners/${p.id}`, { method: "DELETE" })).json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || "삭제 실패");
      setNotice("거래처를 지웠습니다.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 실패"); }
  }

  return (
    <div className="b2b-container fac-partners">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">거래처</h1></div>
        <div className="b2b-page-actions">
          {admin && <button className="b2b-btn-secondary" onClick={() => setCompany(true)}>회사 정보</button>}
          {admin && <button className="b2b-btn-secondary" disabled={busy} onClick={collect}>{busy ? "모으는 중..." : "기록에서 모으기"}</button>}
          <button className="b2b-btn-primary" onClick={() => { setNotice(""); setEdit("new"); }}>거래처 등록</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {notice && <div className="sm-success">{notice}</div>}

      <div className="fac-toolbar">
        <div className="sm-tabs">
          {FILTERS.map((f) => (
            <button key={f} type="button" className={`sm-tab ${filter === f ? "is-active" : ""}`} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
        <input className="b2b-input fac-search" value={kw} onChange={(e) => setKw(hangulInputValue(e))} placeholder="업체명·사업자번호·담당자 검색" />
      </div>

      {loading ? <div className="b2b-loading">불러오는 중...</div> : shown.length === 0 ? (
        !error && <div className="b2b-empty">{rows.length === 0 ? "등록된 거래처가 없습니다." : "조건에 맞는 거래처가 없습니다."}</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table is-clickable">
            <thead><tr><th>업체명</th><th>구분</th><th>사업자번호</th><th>대표자</th><th>담당자</th><th>연락처</th><th>결제조건</th><th></th></tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} onClick={() => { setNotice(""); setEdit(p); }}>
                  <td data-label="업체명"><strong>{p.name}</strong></td>
                  <td data-label="구분" className="sm-nowrap">{p.kind}</td>
                  <td data-label="사업자번호" className="sm-nowrap">{formatBizNo(p.biz_no) || "-"}</td>
                  <td data-label="대표자">{p.ceo_name || "-"}</td>
                  <td data-label="담당자">{p.contact_name || "-"}</td>
                  <td data-label="연락처" className="sm-nowrap">{p.contact_phone || "-"}</td>
                  <td data-label="결제조건">{p.payment_terms || "-"}</td>
                  <td className="sm-nowrap" onClick={(e) => e.stopPropagation()}>
                    {admin && <button type="button" className="b2b-link-btn fac-cancel" onClick={() => remove(p)}>삭제</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {edit && (
        <PartnerModal partner={edit === "new" ? null : edit} onClose={() => setEdit(null)}
          onSaved={(msg) => { setEdit(null); setNotice(msg); load(); }} />
      )}
      {company && <CompanyModal onClose={() => setCompany(false)} onSaved={() => { setCompany(false); setNotice("회사 정보를 저장했습니다."); }} />}
    </div>
  );
}

function PartnerModal({ partner, onClose, onSaved }: { partner: FactoryPartner | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [f, setF] = useState<PartnerInput>(() => (partner ? { ...EMPTY_PARTNER, ...partner } : { ...EMPTY_PARTNER }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEscClose(onClose, saving);
  const set = (k: keyof PartnerInput, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    if (!f.name.trim()) { setError("업체명을 입력하세요."); return; }
    setSaving(true); setError("");
    try {
      const res = await fetch(partner ? `/api/factory/partners/${partner.id}` : "/api/factory/partners", {
        method: partner ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f),
      });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || "저장 실패");
      onSaved(partner ? "거래처를 고쳤습니다." : "거래처를 등록했습니다.");
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }
  const text = (k: keyof PartnerInput, label: string, type = "text") => (
    <label className="b2b-field">
      <span className="b2b-field-label">{label}</span>
      <input className="b2b-input" type={type} value={(f[k] as string | null) || ""} onChange={(e) => set(k, e.target.value)} />
    </label>
  );

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal fac-partner-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">{partner ? "거래처 수정" : "거래처 등록"}</span>
          <button className="b2b-modal-close" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="b2b-modal-body fac-partner-form">
          <label className="b2b-field fac-wide">
            <span className="b2b-field-label">업체명</span>
            <input className="b2b-input" value={f.name} maxLength={60} autoFocus onChange={(e) => set("name", hangulInputValue(e))} />
          </label>
          <div className="b2b-field fac-wide">
            <span className="b2b-field-label">구분</span>
            <div className="sm-tabs">
              {PARTNER_KINDS.map((k) => (
                <button key={k} type="button" className={`sm-tab ${f.kind === k ? "is-active" : ""}`} onClick={() => setF((p) => ({ ...p, kind: k as PartnerKind }))}>{k}</button>
              ))}
            </div>
          </div>
          {text("biz_no", "사업자등록번호")}
          {text("ceo_name", "대표자명")}
          {text("contact_name", "담당자명")}
          {text("contact_phone", "담당자 연락처", "tel")}
          <div className="fac-wide">{text("contact_email", "담당자 이메일", "email")}</div>
          <div className="fac-wide">{text("address", "주소")}</div>
          <div className="fac-wide">{text("payment_terms", "결제조건")}</div>
          <label className="b2b-field fac-wide">
            <span className="b2b-field-label">메모</span>
            <textarea className="b2b-input" rows={2} value={f.memo || ""} onChange={(e) => set("memo", e.target.value)} />
          </label>
          {error && <div className="b2b-error fac-wide">{error}</div>}
        </div>
        <div className="b2b-modal-foot">
          <span />
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>닫기</button>
            <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중..." : "저장"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 출고증에 찍히는 회사 정보 — 관리자만. 로고·직인은 PNG·JPG(300KB 까지)를 골라 넣는다.
function CompanyModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [c, setC] = useState<FactoryCompany>({ ...EMPTY_COMPANY });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEscClose(onClose, saving);

  useEffect(() => {
    (async () => {
      try {
        const j = await (await fetch("/api/factory/company", { cache: "no-store" })).json();
        if (!j.ok) throw new Error(j.error || "조회 실패");
        setC({ ...EMPTY_COMPANY, ...j.company });
      } catch (e) { setError(e instanceof Error ? e.message : "조회 실패"); }
      setLoading(false);
    })();
  }, []);

  function pickImage(key: "logo" | "seal", file: File | undefined) {
    if (!file) return;
    setError("");
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setError("그림은 PNG·JPG 파일만 넣을 수 있습니다."); return; }
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result || "");
      if (url.length > MAX_IMAGE_CHARS) { setError("그림이 너무 큽니다(300KB 까지)."); return; }
      setC((p) => ({ ...p, [key]: url }));
    };
    r.readAsDataURL(file);
  }

  async function save() {
    setSaving(true); setError("");
    try {
      const res = await fetch("/api/factory/company", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || "저장 실패");
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }
  const text = (k: "name" | "ceo" | "tel" | "fax", label: string) => (
    <label className="b2b-field">
      <span className="b2b-field-label">{label}</span>
      <input className="b2b-input" value={c[k]} maxLength={60} onChange={(e) => setC((p) => ({ ...p, [k]: e.target.value }))} />
    </label>
  );
  const image = (k: "logo" | "seal", label: string) => (
    <div className="b2b-field">
      <span className="b2b-field-label">{label}</span>
      <div className="fac-co-image">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {c[k] ? <img src={c[k]} alt={label} /> : <span className="sm-faint">없음</span>}
        <label className="b2b-btn-secondary fac-upload">
          파일 고르기
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { pickImage(k, e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {c[k] && <button type="button" className="b2b-link-btn" onClick={() => setC((p) => ({ ...p, [k]: "" }))}>지우기</button>}
      </div>
    </div>
  );

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal fac-partner-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">회사 정보</span>
          <button className="b2b-modal-close" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="b2b-modal-body fac-partner-form">
          {loading ? <div className="b2b-loading fac-wide">불러오는 중...</div> : (
            <>
              {text("name", "상호")}
              {text("ceo", "대표")}
              {text("tel", "전화")}
              {text("fax", "팩스")}
              {image("logo", "로고")}
              {image("seal", "직인")}
            </>
          )}
          {error && <div className="b2b-error fac-wide">{error}</div>}
        </div>
        <div className="b2b-modal-foot">
          <span />
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>닫기</button>
            <button className="b2b-btn-primary" onClick={save} disabled={saving || loading}>{saving ? "저장 중..." : "저장"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
