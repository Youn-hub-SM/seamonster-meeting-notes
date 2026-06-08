"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Company, CompanyInput, EMPTY_COMPANY } from "@/app/lib/b2b-types";

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
      return [c.name, c.contact_name, c.contact_phone, c.biz_no, c.address]
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
            placeholder="업체명·담당자·연락처·사업자번호·주소 검색"
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
            <table className="b2b-table">
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
                        },
                      })
                    }
                  >
                    <td><strong>{c.name}</strong></td>
                    <td>{c.contact_name || "-"}</td>
                    <td>{c.contact_phone || "-"}</td>
                    <td>{c.biz_no || "-"}</td>
                    <td>{c.payment_terms || "-"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
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
                        style={{ padding: "5px 10px", fontSize: 12, marginRight: 6 }}
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
  saving,
  onChange,
  onSave,
  onClose,
  onDelete,
}: {
  mode: "create" | "edit";
  data: CompanyInput;
  saving: boolean;
  onChange: (d: CompanyInput) => void;
  onSave: () => void;
  onClose: () => void;
  onDelete?: () => void;
}) {
  function set<K extends keyof CompanyInput>(key: K, value: CompanyInput[K]) {
    onChange({ ...data, [key]: value });
  }

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <h2 className="b2b-modal-title">{mode === "create" ? "새 업체 등록" : "업체 수정"}</h2>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="b2b-modal-body">
          <Field label="업체명" required>
            <input
              type="text"
              className="b2b-input"
              value={data.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="예: 마린푸드"
              autoFocus
            />
          </Field>

          <div className="b2b-field-row">
            <Field label="사업자등록번호">
              <input
                type="text"
                className="b2b-input"
                value={data.biz_no ?? ""}
                onChange={(e) => set("biz_no", e.target.value)}
                placeholder="123-45-67890"
              />
            </Field>
            <Field label="대표자명">
              <input
                type="text"
                className="b2b-input"
                value={data.ceo_name ?? ""}
                onChange={(e) => set("ceo_name", e.target.value)}
                placeholder="홍길동"
              />
            </Field>
          </div>

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

          <Field label="기본 배송지">
            <input
              type="text"
              className="b2b-input"
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
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="b2b-field">
      <label className="b2b-field-label">
        {label}
        {required && <span className="req">*</span>}
      </label>
      {children}
    </div>
  );
}
