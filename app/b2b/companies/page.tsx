"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Company, CompanyInput, EMPTY_COMPANY, formatPhone, formatBizNo, checkBizNo } from "@/app/lib/b2b-types";

type Modal = { mode: "create" | "edit"; data: CompanyInput } | null;

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<Modal>(null);
  const [saving, setSaving] = useState(false);

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/companies", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "조회 실패");
      setCompanies(data.companies || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }

  useEffect(() => {
    reload();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter((c) => {
      return [c.name, c.ceo_name, c.contact_name, c.contact_phone, c.contact_email, c.biz_no, c.address, c.payment_terms, c.notes]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q));
    });
  }, [companies, search]);

  async function handleSave() {
    if (!modal) return;
    if (!modal.data.name.trim()) {
      setError("업체명은 필수입니다.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const method = modal.mode === "create" ? "POST" : "PUT";
      const res = await fetch("/api/b2b/companies", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modal.data),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "저장 실패");

      const saved = data.company as Company;
      if (modal.mode === "create") {
        setCompanies((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name, "ko")));
      } else {
        setCompanies((prev) => prev.map((c) => (c.id === saved.id ? saved : c)));
      }
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 중 오류");
    }
    setSaving(false);
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`"${name}" 업체를 삭제하시겠어요?\n(이 업체의 발주가 있으면 삭제 안 됨)`)) return;
    setError("");
    const snapshot = companies;
    setCompanies((prev) => prev.filter((c) => c.id !== id));
    try {
      const res = await fetch(`/api/b2b/companies?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setCompanies(snapshot);
        throw new Error(data.error || "삭제 실패");
      }
      if (modal && modal.data.id === id) setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 중 오류");
    }
  }

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">업체 주소록</h1>
          <p className="b2b-page-subtitle">
            거래처 정보 · 사업자등록번호 · 결제 조건을 관리합니다. {companies.length > 0 && `(전체 ${companies.length}개)`}
          </p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={reload} disabled={loading}>
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
          <button
            className="b2b-btn-primary"
            onClick={() => setModal({ mode: "create", data: { ...EMPTY_COMPANY } })}
          >
            + 업체 추가
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="b2b-card">
        <div className="b2b-card-head">
          <input
            type="text"
            className="b2b-search"
            placeholder="업체명·대표자·담당자·연락처·이메일·사업자번호·주소·결제조건·메모 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="b2b-empty">
            <div className="b2b-empty-icon">🏢</div>
            {companies.length === 0
              ? "등록된 업체가 없습니다. 우측 상단 [+ 업체 추가] 를 눌러 시작하세요."
              : "검색 결과가 없습니다."}
          </div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table is-responsive">
              <thead>
                <tr>
                  <th>업체명</th>
                  <th>담당자</th>
                  <th>연락처</th>
                  <th>사업자번호</th>
                  <th>결제조건</th>
                  <th style={{ whiteSpace: "nowrap" }}>최근 발주</th>
                  <th className="actions"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() =>
                      setModal({
                        mode: "edit",
                        data: {
                          id: c.id,
                          name: c.name,
                          biz_no: c.biz_no ?? "",
                          ceo_name: c.ceo_name ?? "",
                          contact_name: c.contact_name ?? "",
                          contact_phone: c.contact_phone ?? "",
                          contact_email: c.contact_email ?? "",
                          address: c.address ?? "",
                          payment_terms: c.payment_terms ?? "",
                          notes: c.notes ?? "",
                          biz_doc_path: c.biz_doc_path ?? null,
                        },
                      })
                    }
                  >
                    <td data-label="업체명"><strong>{c.name}</strong></td>
                    <td data-label="담당자">{c.contact_name || "-"}</td>
                    <td data-label="연락처">{c.contact_phone ? formatPhone(c.contact_phone) : "-"}</td>
                    <td data-label="사업자번호">{c.biz_no ? formatBizNo(c.biz_no) : "-"}</td>
                    <td data-label="결제조건">{c.payment_terms || "-"}</td>
                    <td data-label="최근 발주" style={{ whiteSpace: "nowrap" }}>
                      {c.last_order_date ? (
                        c.last_order_date
                      ) : (
                        <span style={{ color: "var(--sm-text-light)" }}>발주 없음</span>
                      )}
                    </td>
                    <td className="actions" onClick={(e) => e.stopPropagation()}>
                      <Link
                        href={`/b2b/companies/${c.id}`}
                        className="b2b-btn-secondary"
                        style={{ padding: "5px 10px", fontSize: 10, marginRight: 6 }}
                      >
                        상세
                      </Link>
                      <button className="b2b-btn-danger" onClick={() => handleDelete(c.id, c.name)}>
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <CompanyModal
          mode={modal.mode}
          data={modal.data}
          companies={companies}
          saving={saving}
          onChange={(data) => setModal({ ...modal, data })}
          onSave={handleSave}
          onClose={() => setModal(null)}
          onDelete={
            modal.mode === "edit" && modal.data.id
              ? () => handleDelete(modal.data.id!, modal.data.name)
              : undefined
          }
        />
      )}
    </>
  );
}

function CompanyModal({
  mode,
  data,
  companies,
  saving,
  onChange,
  onSave,
  onClose,
  onDelete,
}: {
  mode: "create" | "edit";
  data: CompanyInput;
  companies: Company[];
  saving: boolean;
  onChange: (d: CompanyInput) => void;
  onSave: () => void;
  onClose: () => void;
  onDelete?: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  // OCR 로 자동 입력된 칸(확인 필요 강조 대상)
  const [aiFields, setAiFields] = useState<Set<keyof CompanyInput>>(new Set());
  // 첨부 문서 미리보기 (서명 URL)
  const [docUrl, setDocUrl] = useState("");
  const docKind = (data.biz_doc_path || "").toLowerCase().endsWith(".pdf") ? "pdf" : "image";

  // 첨부가 바뀌면 미리보기 URL 갱신
  useEffect(() => {
    let alive = true;
    if (!data.biz_doc_path) { setDocUrl(""); return; }
    (async () => {
      try {
        const j = await (await fetch(`/api/b2b/companies/doc?path=${encodeURIComponent(data.biz_doc_path!)}`)).json();
        if (alive && j.ok) setDocUrl(j.url);
      } catch { /* 미리보기 실패는 무시 */ }
    })();
    return () => { alive = false; };
  }, [data.biz_doc_path]);

  // 사업자번호 검증 + 중복 검사
  const bizCheck = checkBizNo(data.biz_no);
  const bizDigits = String(data.biz_no ?? "").replace(/\D/g, "");
  const dupCompany = bizDigits.length === 10
    ? companies.find((c) => c.id !== data.id && String(c.biz_no ?? "").replace(/\D/g, "") === bizDigits)
    : undefined;

  // OCR 강조 스타일
  const aiStyle = (k: keyof CompanyInput): React.CSSProperties =>
    aiFields.has(k) ? { background: "var(--sm-warning-bg)", borderColor: "#F0C000" } : {};
  const aiBadge = (k: keyof CompanyInput) =>
    aiFields.has(k) ? (
      <span style={{ marginLeft: 6, fontSize: 8.5, fontWeight: 700, color: "var(--sm-warning)", background: "var(--sm-warning-bg)", padding: "1px 6px", borderRadius: 8 }}>
        확인 필요
      </span>
    ) : null;

  function set<K extends keyof CompanyInput>(key: K, value: CompanyInput[K]) {
    if (aiFields.has(key)) {
      const n = new Set(aiFields);
      n.delete(key);
      setAiFields(n);
    }
    onChange({ ...data, [key]: value });
  }

  async function handleScan(file: File) {
    setScanning(true);
    setScanMsg("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/b2b/companies/scan-doc", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "업로드 실패");

      const next: CompanyInput = { ...data, biz_doc_path: j.path };
      const filled = new Set<keyof CompanyInput>();
      const f = j.fields;
      if (f) {
        if (f.name) { next.name = f.name; filled.add("name"); }
        if (f.biz_no) { next.biz_no = f.biz_no; filled.add("biz_no"); }
        if (f.ceo_name) { next.ceo_name = f.ceo_name; filled.add("ceo_name"); }
        if (f.address) { next.address = f.address; filled.add("address"); }
        const extra = [
          f.biz_type && `업태: ${f.biz_type}`,
          f.biz_item && `종목: ${f.biz_item}`,
          f.opened_on && `개업일: ${f.opened_on}`,
        ].filter(Boolean).join(" / ");
        if (extra) next.notes = data.notes ? `${data.notes}\n${extra}` : extra;
      }
      setAiFields(filled);
      onChange(next);
      setScanMsg(j.extractError ? "파일은 첨부됐지만 자동 인식에 실패했어요. 직접 입력해주세요." : "✓ 인식 완료 — 노란 칸을 원본과 대조해 확인 후 저장하세요.");
    } catch (err) {
      setScanMsg(err instanceof Error ? err.message : "오류");
    }
    setScanning(false);
  }

  async function viewDoc() {
    if (!data.biz_doc_path) return;
    try {
      const res = await fetch(`/api/b2b/companies/doc?path=${encodeURIComponent(data.biz_doc_path)}`);
      const j = await res.json();
      if (j.ok) window.open(j.url, "_blank");
      else setScanMsg(j.error || "파일 열기 실패");
    } catch {
      setScanMsg("파일 열기 실패");
    }
  }

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="b2b-modal-head">
          <h2 className="b2b-modal-title">{mode === "create" ? "새 업체 등록" : "업체 수정"}</h2>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="b2b-modal-body">
          {/* 사업자등록증 자동 입력 */}
          <div style={{ border: "1px dashed var(--sm-border)", borderRadius: 10, padding: "12px 14px", marginBottom: 16, background: "var(--sm-bg)" }}>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleScan(f);
                e.target.value = "";
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                className="b2b-btn-secondary"
                onClick={() => fileRef.current?.click()}
                disabled={scanning}
              >
                {scanning ? "인식 중..." : "📄 사업자등록증으로 자동 입력"}
              </button>
              {data.biz_doc_path && (
                <>
                  <span style={{ fontSize: 10.5, color: "var(--sm-success)", fontWeight: 600 }}>✓ 첨부됨</span>
                  <button type="button" className="b2b-link-btn" onClick={viewDoc} style={{ fontSize: 10.5 }}>보기</button>
                  <button
                    type="button"
                    className="b2b-link-btn"
                    onClick={() => set("biz_doc_path", null)}
                    style={{ fontSize: 10.5, color: "var(--sm-danger)" }}
                  >
                    제거
                  </button>
                </>
              )}
            </div>
            <div style={{ fontSize: 9.5, color: "var(--sm-text-light)", marginTop: 6 }}>
              이미지·PDF(최대 5MB)를 올리면 상호·사업자번호·대표자·주소를 자동으로 채웁니다. 값은 확인 후 저장하세요.
            </div>
            {scanMsg && (
              <div style={{ fontSize: 10.5, marginTop: 8, color: scanMsg.startsWith("✓") ? "var(--sm-success)" : "var(--sm-danger)" }}>{scanMsg}</div>
            )}
          </div>

          {/* 첨부 원본 미리보기 — 채워진 값과 1:1 대조 */}
          {docUrl && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: "var(--sm-text-mid)", marginBottom: 6 }}>
                첨부 원본 — 노란 칸을 이 원본과 대조해 확인하세요
              </div>
              {docKind === "image" ? (
                <img
                  src={docUrl}
                  alt="사업자등록증"
                  onClick={viewDoc}
                  style={{ maxWidth: "100%", maxHeight: 340, borderRadius: 8, border: "1px solid var(--sm-border)", cursor: "zoom-in", display: "block" }}
                />
              ) : (
                <button type="button" className="b2b-btn-secondary" onClick={viewDoc}>📄 PDF 원본 열기</button>
              )}
            </div>
          )}

          <Field label="업체명" required badge={aiBadge("name")}>
            <input
              type="text"
              className="b2b-input"
              style={aiStyle("name")}
              value={data.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="예: 마린푸드"
              autoFocus
            />
          </Field>

          <div className="b2b-field-row">
            <Field label="사업자등록번호" badge={aiBadge("biz_no")}>
              <input
                type="text"
                className="b2b-input"
                style={aiStyle("biz_no")}
                value={data.biz_no ?? ""}
                onChange={(e) => set("biz_no", e.target.value)}
                placeholder="123-45-67890"
              />
            </Field>
            <Field label="대표자명" badge={aiBadge("ceo_name")}>
              <input
                type="text"
                className="b2b-input"
                style={aiStyle("ceo_name")}
                value={data.ceo_name ?? ""}
                onChange={(e) => set("ceo_name", e.target.value)}
                placeholder="홍길동"
              />
            </Field>
          </div>
          {(bizCheck === "invalid" || dupCompany) && (
            <div style={{ marginTop: -6, marginBottom: 12, fontSize: 10.5, display: "flex", flexDirection: "column", gap: 3 }}>
              {bizCheck === "invalid" && (
                <div style={{ color: "var(--sm-danger)" }}>⚠ 사업자등록번호 검증에 실패했습니다 — 숫자를 잘못 읽었을 수 있어요. 원본과 대조해 확인하세요.</div>
              )}
              {dupCompany && (
                <div style={{ color: "var(--sm-warning)" }}>⚠ 이미 ‘{dupCompany.name}’ 에 등록된 사업자번호입니다.</div>
              )}
            </div>
          )}

          <div className="b2b-field-row">
            <Field label="담당자명">
              <input
                type="text"
                className="b2b-input"
                value={data.contact_name ?? ""}
                onChange={(e) => set("contact_name", e.target.value)}
              />
            </Field>
            <Field label="담당자 연락처">
              <input
                type="text"
                className="b2b-input"
                value={data.contact_phone ?? ""}
                onChange={(e) => set("contact_phone", e.target.value)}
                placeholder="010-0000-0000"
              />
            </Field>
          </div>

          <Field label="담당자 이메일">
            <input
              type="email"
              className="b2b-input"
              value={data.contact_email ?? ""}
              onChange={(e) => set("contact_email", e.target.value)}
              placeholder="contact@example.com"
            />
          </Field>

          <Field label="기본 배송지" badge={aiBadge("address")}>
            <input
              type="text"
              className="b2b-input"
              style={aiStyle("address")}
              value={data.address ?? ""}
              onChange={(e) => set("address", e.target.value)}
              placeholder="(우편번호) 시/도 시/군/구 도로명 + 상세"
            />
          </Field>

          <Field label="결제조건">
            <input
              type="text"
              className="b2b-input"
              value={data.payment_terms ?? ""}
              onChange={(e) => set("payment_terms", e.target.value)}
              placeholder="예: 월말정산, 선입금, 발송후 7일"
            />
          </Field>

          <Field label="메모">
            <textarea
              className="b2b-textarea"
              value={data.notes ?? ""}
              onChange={(e) => set("notes", e.target.value)}
              rows={3}
              placeholder="자유 메모"
            />
          </Field>
        </div>

        <div className="b2b-modal-foot">
          {onDelete ? (
            <button className="b2b-btn-danger" onClick={onDelete} disabled={saving}>
              삭제
            </button>
          ) : (
            <span />
          )}
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>
              취소
            </button>
            <button className="b2b-btn-primary" onClick={onSave} disabled={saving || !data.name.trim()}>
              {saving ? "저장 중..." : mode === "create" ? "등록" : "수정"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  badge,
  children,
}: {
  label: string;
  required?: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="b2b-field">
      <label className="b2b-field-label">
        {label}
        {required && <span className="req">*</span>}
        {badge}
      </label>
      {children}
    </div>
  );
}
