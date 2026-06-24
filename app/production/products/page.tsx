"use client";

import { useRef, useState } from "react";

type Row = { sku: string; name: string; spec: string | null };
type UpdateRow = Row & { oldName: string; oldSpec: string | null };
type Preview = { total: number; skippedNoSku: number; unchanged: number; toAdd: Row[]; toUpdate: UpdateRow[] };

export default function ProductsUploadPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ added: number; updated: number } | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setPreview(null);
    setDone(null);
    setError("");
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/production/products/import", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "파싱 실패");
      setPreview(j);
    } catch (err) {
      setError(err instanceof Error ? err.message : "업로드 실패");
    }
    setLoading(false);
  }

  async function apply(mode: "addOnly" | "all") {
    if (!preview) return;
    const rows =
      mode === "addOnly"
        ? [...preview.toAdd]
        : [...preview.toAdd, ...preview.toUpdate.map((r) => ({ sku: r.sku, name: r.name, spec: r.spec }))];
    if (rows.length === 0) return;
    setApplying(true);
    setError("");
    try {
      const res = await fetch("/api/production/products/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "반영 실패");
      setDone({ added: j.added, updated: j.updated });
      setPreview(null);
      setFileName("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "반영 실패");
    }
    setApplying(false);
  }

  const changeCount = preview ? preview.toAdd.length + preview.toUpdate.length : 0;

  return (
    <div className="b2b-container" style={{ maxWidth: 920 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">품목 업로드</h1>
          <p className="b2b-page-subtitle">
            박스히어로 품목 내보내기(엑셀)를 올리면 SKU 기준으로 신규 추가·이름 갱신합니다. 금액은 가져오지 않습니다(B2B 원가 보존).
          </p>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <section className="b2b-card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button className="b2b-btn-secondary" onClick={() => fileRef.current?.click()} disabled={loading}>
            {loading ? "분석 중..." : "엑셀 선택"}
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={onFile} style={{ display: "none" }} />
          {fileName && <span style={{ fontSize: 13, color: "var(--sm-text-mid)" }}>{fileName}</span>}
        </div>
        <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--sm-text-light)", lineHeight: 1.6 }}>
          박스히어로 → 품목 → 내보내기(엑셀). 필요한 컬럼: <strong>SKU · 제품명 · 옵션</strong>. (구매가·판매가·재고 등은 무시)
        </div>
      </section>

      {done && (
        <div className="prod-sku-ok" style={{ fontSize: 14, marginBottom: 16 }}>
          ✓ 반영 완료 — 신규 {done.added}개 추가, {done.updated}개 갱신.
        </div>
      )}

      {preview && (
        <>
          <div className="b2b-dash-grid" style={{ marginBottom: 16 }}>
            <div className="b2b-stat-card">
              <div className="b2b-stat-card-label">신규 추가</div>
              <div className="b2b-stat-card-value" style={{ color: "var(--sm-orange)" }}>{preview.toAdd.length}</div>
            </div>
            <div className="b2b-stat-card">
              <div className="b2b-stat-card-label">이름·옵션 갱신</div>
              <div className="b2b-stat-card-value">{preview.toUpdate.length}</div>
            </div>
            <div className="b2b-stat-card">
              <div className="b2b-stat-card-label">변동 없음</div>
              <div className="b2b-stat-card-value" style={{ color: "var(--sm-text-light)" }}>{preview.unchanged}</div>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            {preview.toAdd.length > 0 && (
              <button className="b2b-btn-secondary" onClick={() => apply("addOnly")} disabled={applying}>
                신규 {preview.toAdd.length}건만 추가
              </button>
            )}
            <button className="b2b-btn-primary" onClick={() => apply("all")} disabled={applying || changeCount === 0}>
              {applying ? "반영 중..." : changeCount === 0 ? "변경할 항목 없음" : `전체 ${changeCount}건 반영 (이름 갱신 포함)`}
            </button>
          </div>

          {preview.toAdd.length > 0 && (
            <section style={{ marginBottom: 18 }}>
              <h2 className="b2b-card-title" style={{ marginBottom: 8 }}>신규 추가 ({preview.toAdd.length})</h2>
              <div className="b2b-table-wrap">
                <table className="b2b-table">
                  <thead><tr><th>SKU</th><th>제품명</th><th>옵션</th></tr></thead>
                  <tbody>
                    {preview.toAdd.map((r) => (
                      <tr key={r.sku}>
                        <td><code style={{ fontSize: 12 }}>{r.sku}</code></td>
                        <td>{r.name}</td>
                        <td>{r.spec || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {preview.toUpdate.length > 0 && (
            <section>
              <h2 className="b2b-card-title" style={{ marginBottom: 8 }}>이름·옵션 갱신 ({preview.toUpdate.length})</h2>
              <div className="b2b-table-wrap">
                <table className="b2b-table">
                  <thead><tr><th>SKU</th><th>변경 전</th><th>변경 후</th></tr></thead>
                  <tbody>
                    {preview.toUpdate.map((r) => (
                      <tr key={r.sku}>
                        <td><code style={{ fontSize: 12 }}>{r.sku}</code></td>
                        <td style={{ color: "var(--sm-text-light)" }}>{r.oldName}{r.oldSpec ? ` · ${r.oldSpec}` : ""}</td>
                        <td>{r.name}{r.spec ? ` · ${r.spec}` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {changeCount === 0 && (
            <div className="b2b-empty"><div className="b2b-empty-icon">✅</div>모든 품목이 이미 최신 상태입니다.</div>
          )}
        </>
      )}
    </div>
  );
}
