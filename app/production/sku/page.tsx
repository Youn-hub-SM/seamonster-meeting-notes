"use client";

import { useEffect, useMemo, useState } from "react";
import { SPECIES, LINES, CUTS, LineKey, generateSku, findSpecies } from "@/app/lib/production-sku";

type ProdLite = { sku: string | null; name: string; spec: string | null };

export default function SkuGeneratorPage() {
  const [lineKey, setLineKey] = useState<LineKey>("retail100");
  const [speciesCode, setSpeciesCode] = useState<string>("GA");
  const [customCode, setCustomCode] = useState<string>("");
  const [cut, setCut] = useState<string>("100");
  const [midOverride, setMidOverride] = useState<string>("");
  const [products, setProducts] = useState<ProdLite[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/b2b/products", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setProducts((j.products || []).map((p: ProdLite) => ({ sku: p.sku, name: p.name, spec: p.spec }))))
      .catch(() => {});
  }, []);

  const line = LINES.find((l) => l.key === lineKey)!;
  const usingCustom = speciesCode === "__custom__";
  const effectiveCode = (usingCustom ? customCode : speciesCode).trim().toUpperCase();

  const sku = useMemo(() => {
    if (!effectiveCode) return "";
    return generateSku(lineKey, effectiveCode, cut, midOverride);
  }, [lineKey, effectiveCode, cut, midOverride]);

  // 중복 검사 (대소문자 무시)
  const existing = useMemo(() => {
    if (!sku) return [];
    return products.filter((p) => (p.sku || "").toUpperCase() === sku.toUpperCase());
  }, [products, sku]);

  // 어종이 바뀌면 가운데코드 오버라이드 초기화
  useEffect(() => { setMidOverride(""); setCopied(false); }, [speciesCode, customCode, lineKey, cut]);

  async function copy() {
    if (!sku) return;
    try {
      await navigator.clipboard.writeText(sku);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard 미지원 — 무시 */ }
  }

  const sp = findSpecies(effectiveCode);

  return (
    <div className="b2b-container" style={{ maxWidth: 880 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">SKU 생성기</h1>
          <p className="b2b-page-subtitle">
            라인·어종·규격을 고르면 기존 SKU 규칙대로 코드를 만들어줍니다. 중복도 즉시 확인됩니다.
          </p>
        </div>
      </header>

      <section className="b2b-form-section">
        <div className="b2b-field-row">
          <div className="b2b-field">
            <label className="b2b-field-label">라인(포장)</label>
            <select className="b2b-select" value={lineKey} onChange={(e) => setLineKey(e.target.value as LineKey)}>
              {LINES.map((l) => (
                <option key={l.key} value={l.key}>{l.label} — {l.desc}</option>
              ))}
            </select>
          </div>
          <div className="b2b-field">
            <label className="b2b-field-label">어종</label>
            <select className="b2b-select" value={speciesCode} onChange={(e) => setSpeciesCode(e.target.value)}>
              {SPECIES.map((s) => (
                <option key={s.code} value={s.code}>{s.name} ({s.code})</option>
              ))}
              <option value="__custom__">+ 직접 입력 (새 어종)</option>
            </select>
          </div>
        </div>

        <div className="b2b-field-row" style={{ marginTop: 12 }}>
          {usingCustom && (
            <div className="b2b-field">
              <label className="b2b-field-label">새 어종 코드</label>
              <input
                className="b2b-input"
                value={customCode}
                onChange={(e) => setCustomCode(e.target.value.toUpperCase())}
                placeholder="예: MK (고등어)"
                style={{ textTransform: "uppercase" }}
              />
            </div>
          )}
          {line.needsCut && (
            <div className="b2b-field">
              <label className="b2b-field-label">절단 규격</label>
              <select className="b2b-select" value={cut} onChange={(e) => setCut(e.target.value)}>
                {CUTS.map((c) => (
                  <option key={c} value={c}>{c}g</option>
                ))}
              </select>
            </div>
          )}
          {lineKey === "retail100" && (
            <div className="b2b-field">
              <label className="b2b-field-label">가운데 코드 {sp ? `(기본 ${sp.retailMid})` : ""}</label>
              <input
                className="b2b-input"
                value={midOverride}
                onChange={(e) => setMidOverride(e.target.value.toUpperCase())}
                placeholder={sp?.retailMid || "K"}
                style={{ textTransform: "uppercase" }}
              />
              <span style={{ fontSize: 11.5, color: "var(--sm-text-light)", marginTop: 4 }}>
                산지/가공 코드로 추정 — 비우면 어종 기본값 사용
              </span>
            </div>
          )}
          {!usingCustom && !line.needsCut && lineKey !== "retail100" && (
            <div className="b2b-field" aria-hidden />
          )}
        </div>
      </section>

      {/* 결과 */}
      <section className="prod-sku-result">
        <div className="prod-sku-label">생성된 SKU</div>
        <div className="prod-sku-value">{sku || "—"}</div>
        <button className="b2b-btn-primary" onClick={copy} disabled={!sku}>
          {copied ? "복사됨 ✓" : "복사"}
        </button>
        {sku && existing.length > 0 && (
          <div className="prod-sku-warn">
            ⚠ 이미 사용 중인 SKU입니다 — {existing.map((p) => `${p.name}${p.spec ? ` (${p.spec})` : ""}`).join(", ")}
          </div>
        )}
        {sku && existing.length === 0 && (
          <div className="prod-sku-ok">✓ 중복 없음 — 사용 가능</div>
        )}
      </section>

      {/* 규칙 요약 */}
      <section className="b2b-card" style={{ marginTop: 20 }}>
        <div className="b2b-card-head"><h2 className="b2b-card-title">SKU 규칙 요약</h2></div>
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead>
              <tr><th>라인</th><th>패턴</th><th>예시</th></tr>
            </thead>
            <tbody>
              <tr><td>100g 소매</td><td><code>{"{어종}-100-{mid}-100"}</code></td><td>GA-100-K-100</td></tr>
              <tr><td>1kg 팩</td><td><code>{"P_{어종}-{규격}X1"}</code></td><td>P_GA-100X1</td></tr>
              <tr><td>5kg×2 벌크</td><td><code>{"BULK-{어종}-{규격}"}</code></td><td>BULK-GA-200</td></tr>
              <tr><td>더간편한 (85g)</td><td><code>{"R-{어종}"}</code></td><td>R-YA</td></tr>
              <tr><td>더간편한 (425g)</td><td><code>{"P_R-{어종}"}</code></td><td>P_R-YA</td></tr>
              <tr><td>더 깨끗한</td><td><code>{"{어종}-20-K-120"}</code></td><td>DG-20-K-120</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
