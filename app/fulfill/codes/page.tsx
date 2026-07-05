"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type Code = { sku: string; name: string; courier_name: string; courier_weight: number };

export default function FulfillCodesPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Code[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch(`/api/fulfill/codes?q=${encodeURIComponent(q.trim())}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []); setTotal(j.total || 0);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true); setError(""); setOk("");
    try {
      const fd = new FormData(); fd.append("file", file);
      const j = await (await fetch("/api/fulfill/codes", { method: "POST", body: fd })).json();
      if (!j.ok) throw new Error(j.error || "업로드 실패");
      setOk(`상품마스터 반영 — 기존 ${(j.updated ?? 0).toLocaleString()}개 갱신 · 신규 ${(j.created ?? 0).toLocaleString()}개 생성.`);
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "업로드 실패"); }
    setImporting(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="b2b-container" style={{ maxWidth: 880 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">택배 코드 (상품마스터)</h1>
          <p className="b2b-page-subtitle">
            택배 상품명·주문당 총중량은 <strong><Link href="/b2b/products">상품마스터</Link>에서 상품별로 관리</strong>합니다.
            여기선 구글시트 <strong>code 탭</strong>(코드명·상품명·총중량)을 올려 <strong>한 번에 반영</strong>할 수 있어요 — 없는 SKU는 상품마스터에 자동 생성됩니다.
          </p>
        </div>
        <div className="b2b-page-actions">
          <Link className="b2b-btn-secondary" href="/fulfill">← 발주처리</Link>
          <button className="b2b-btn-primary" onClick={() => fileRef.current?.click()} disabled={importing}>{importing ? "올리는 중…" : "코드표 업로드"}</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={onFile} style={{ display: "none" }} />
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {ok && <div className="prod-sku-ok" style={{ fontSize: 13, marginBottom: 12 }}>✓ {ok}</div>}

      <section className="b2b-card">
        <div className="b2b-card-head" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span className="b2b-card-title">코드 {total.toLocaleString()}개 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>{q ? `· 검색 ${rows.length}` : rows.length < total ? `· ${rows.length} 표시` : ""}</span></span>
          <input className="b2b-input" placeholder="단품코드·상품명 검색" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        </div>
        {loading ? <div className="b2b-loading">불러오는 중...</div> : rows.length === 0 ? (
          <div className="b2b-empty"><div className="b2b-empty-icon">📄</div>{total === 0 ? "코드표가 비어 있습니다. 우측 상단에서 code 탭 엑셀을 업로드하세요." : "검색 결과가 없습니다."}</div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr><th>단품코드</th><th>품목명</th><th>택배 상품명</th><th className="num">택배 총중량(kg)</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.sku}-${i}`}>
                    <td><code style={{ fontSize: 11 }}>{r.sku}</code></td>
                    <td className="sm-faint" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</td>
                    <td style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.courier_name || <span className="sm-faint">(없음)</span>}</td>
                    <td className="num b2b-money">{r.courier_weight}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
