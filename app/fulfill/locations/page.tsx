"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

// 창고 위치(픽업 구역) 관리 — 송장 스캔 피킹 리스트를 걷는 순서대로 뽑기 위한 설정.
//  · 구역 목록의 위·아래 순서 = 창고를 걷는 경로 (피킹 리스트가 이 순서로 정렬됨)
//  · 품목마다 구역 하나를 지정. 미지정은 리스트 맨 뒤 '위치 미지정' 묶음.
//  · 묶음세트는 목록에 없음(구성품으로 전개되므로 구성품의 위치를 따라감).

type Prod = { id: string; sku: string | null; name: string; active: boolean; pick_zone: string | null };

export default function LocationsPage() {
  const [zones, setZones] = useState<string[]>([]);
  const [products, setProducts] = useState<Prod[]>([]);
  const [zoneCol, setZoneCol] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [newZone, setNewZone] = useState("");
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState("");
  const [onlyUnzoned, setOnlyUnzoned] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const j = await (await fetch("/api/fulfill/locations", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setZones(j.zones);
      setProducts(j.products);
      setZoneCol(j.zoneCol !== false);
      setLoaded(true);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 실패"); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // 구역 목록 저장(추가·삭제·순서변경 즉시 저장). 실패 시 이전 목록 복구.
  async function saveZones(next: string[]) {
    const prev = zones;
    setZones(next);
    setSaving(true);
    try {
      const j = await (await fetch("/api/fulfill/locations", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ zones: next }) })).json();
      if (!j.ok) throw new Error(j.error || "저장 실패");
      setZones(j.zones);
    } catch (e) { setZones(prev); setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }
  function addZone() {
    if (saving) return; // Enter 연타로 PUT 이 겹치면 실패 롤백이 서버와 어긋난다
    const z = newZone.trim();
    if (!z) return;
    if (zones.includes(z)) { setError(`'${z}' 구역이 이미 있습니다.`); return; }
    setError("");
    setNewZone("");
    saveZones([...zones, z]);
  }
  function moveZone(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= zones.length) return;
    const next = [...zones];
    [next[i], next[j]] = [next[j], next[i]];
    saveZones(next);
  }
  function removeZone(i: number) {
    const z = zones[i];
    const n = products.filter((p) => p.pick_zone === z).length;
    if (n > 0 && !confirm(`'${z}' 구역에 품목 ${n}개가 배정돼 있습니다. 삭제하면 해당 품목은 '위치 미지정'으로 뽑힙니다. 삭제할까요?`)) return;
    saveZones(zones.filter((_, k) => k !== i));
  }

  // 품목 구역 배정 — 변경 즉시 저장. 실패 시 그 품목만 이전 값 복구
  // (전체 스냅샷 복원은 동시에 저장 중이던 다른 품목의 성공분까지 되돌려 화면·DB 가 어긋난다).
  async function setProdZone(id: string, zone: string | null) {
    const prevZone = products.find((p) => p.id === id)?.pick_zone ?? null;
    setProducts((ps) => ps.map((p) => (p.id === id ? { ...p, pick_zone: zone } : p)));
    try {
      const j = await (await fetch("/api/fulfill/locations", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product_id: id, zone }) })).json();
      if (!j.ok) throw new Error(j.error || "저장 실패");
      setError("");
    } catch (e) {
      setProducts((ps) => ps.map((p) => (p.id === id ? { ...p, pick_zone: prevZone } : p)));
      setError(e instanceof Error ? e.message : "저장 실패");
    }
  }

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products) if (p.pick_zone) m.set(p.pick_zone, (m.get(p.pick_zone) ?? 0) + 1);
    return m;
  }, [products]);
  // '배치됨' 판정은 피킹 동작과 동일하게: 구역 목록에 있는 구역일 때만.
  // 목록에서 지워진(stale) 구역 품목은 미지정으로 인쇄되므로 여기서도 미지정으로 세고 필터에 노출한다.
  const isZoned = useCallback((p: Prod) => !!p.pick_zone && zones.includes(p.pick_zone), [zones]);
  const unzonedCount = useMemo(() => products.filter((p) => p.active && !isZoned(p)).length, [products, isZoned]);

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return products.filter((p) => {
      if (!showInactive && !p.active) return false;
      if (onlyUnzoned && isZoned(p)) return false;
      if (kw && !p.name.toLowerCase().includes(kw) && !(p.sku ?? "").toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [products, q, onlyUnzoned, showInactive, isZoned]);

  return (
    <div className="b2b-container" style={{ maxWidth: 860 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">창고 위치</h1>
          <p className="b2b-page-subtitle">구역 순서 = 걷는 경로. 피킹 리스트(<Link href="/fulfill/scan">송장 스캔</Link>)가 이 순서대로 정렬됩니다.</p>
        </div>
        <div className="b2b-page-actions"><Link className="b2b-btn-secondary" href="/fulfill/scan">송장 스캔</Link></div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {loaded && !zoneCol && (
        <div className="b2b-error">품목 배정 저장이 꺼져 있습니다 — supabase/migrations/117_pick_zone.sql 를 먼저 적용하세요.</div>
      )}

      <section className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-card-head">
          <span className="b2b-card-title">구역 (걷는 순서){saving && <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}>저장 중…</span>}</span>
        </div>
        {zones.length === 0 ? (
          <div className="b2b-empty" style={{ padding: 18 }}>구역이 없습니다. 창고 입구부터 걷는 순서대로 추가하세요. (예: A선반, B선반, 냉장고 앞)</div>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {zones.map((z, i) => (
              <li key={z} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 4px", borderBottom: "1px solid var(--sm-border)" }}>
                <span className="sm-faint" style={{ width: 22, textAlign: "right", fontSize: 12 }}>{i + 1}</span>
                <strong style={{ flex: 1 }}>{z}</strong>
                <span className="sm-faint" style={{ fontSize: 12 }}>품목 {counts.get(z) ?? 0}개</span>
                <button className="b2b-btn-secondary" onClick={() => moveZone(i, -1)} disabled={i === 0 || saving} style={{ padding: "2px 9px" }}>↑</button>
                <button className="b2b-btn-secondary" onClick={() => moveZone(i, 1)} disabled={i === zones.length - 1 || saving} style={{ padding: "2px 9px" }}>↓</button>
                <button className="b2b-btn-secondary" onClick={() => removeZone(i)} disabled={saving} style={{ padding: "2px 9px", color: "var(--sm-danger)" }}>삭제</button>
              </li>
            ))}
          </ol>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input className="b2b-input" value={newZone} onChange={(e) => setNewZone(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addZone(); } }}
            placeholder="새 구역 이름 (예: A선반)" style={{ flex: 1 }} />
          <button className="b2b-btn-primary" onClick={addZone} disabled={!newZone.trim() || saving}>추가</button>
        </div>
      </section>

      <section className="b2b-card">
        <div className="b2b-card-head">
          <span className="b2b-card-title">품목 배치 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 미지정 {unzonedCount}개</span></span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <input className="b2b-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="품목명·SKU 검색" style={{ flex: "1 1 220px" }} />
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={onlyUnzoned} onChange={(e) => setOnlyUnzoned(e.target.checked)} /> 미지정만
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> 중단 품목 표시
          </label>
        </div>
        {!loaded ? (
          <div className="b2b-empty" style={{ padding: 18 }}>불러오는 중…</div>
        ) : list.length === 0 ? (
          <div className="b2b-empty" style={{ padding: 18 }}>{onlyUnzoned ? "미지정 품목이 없습니다. 전부 배치됐습니다." : "표시할 품목이 없습니다."}</div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr><th>품목명</th><th>SKU</th><th style={{ width: 190 }}>구역</th></tr></thead>
              <tbody>
                {list.map((p) => {
                  const stale = !!p.pick_zone && !zones.includes(p.pick_zone); // 구역 목록에서 지워진 값
                  return (
                    <tr key={p.id} style={{ opacity: p.active ? 1 : 0.55 }}>
                      <td><strong>{p.name}</strong>{!p.active && <span className="sm-faint" style={{ fontSize: 11, marginLeft: 6 }}>중단</span>}</td>
                      <td className="sm-faint">{p.sku || "-"}</td>
                      <td>
                        <select className="b2b-input" value={p.pick_zone ?? ""} disabled={!zoneCol}
                          onChange={(e) => setProdZone(p.id, e.target.value || null)}
                          style={{ padding: "5px 8px", width: "100%", color: stale ? "var(--sm-danger)" : undefined }}>
                          <option value="">미지정</option>
                          {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                          {stale && <option value={p.pick_zone as string}>{p.pick_zone} (목록에 없음)</option>}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 10 }}>
          묶음(세트) 상품은 여기 없습니다 — 피킹 리스트에서 구성품으로 풀리므로 구성품의 위치를 따라갑니다.
          변경은 즉시 저장되며, 스캔 화면에는 최대 1분 안에 반영됩니다.
        </p>
      </section>
    </div>
  );
}
