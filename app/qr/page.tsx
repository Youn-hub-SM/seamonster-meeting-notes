"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Link = { id: string; code: string; target_url: string; title: string | null; active: boolean; scan_count: number; created_by: string | null; created_at: string };
type Scan = { scanned_at: string; referer: string | null; user_agent: string | null; country: string | null };

export default function QrPage() {
  const [links, setLinks] = useState<Link[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"dynamic" | "static">("dynamic");
  const [origin, setOrigin] = useState("");

  // 새 링크
  const [nTarget, setNTarget] = useState("");
  const [nTitle, setNTitle] = useState("");
  const [nCode, setNCode] = useState("");
  const [creating, setCreating] = useState(false);

  const [edit, setEdit] = useState<Link | null>(null);
  const [qrFor, setQrFor] = useState<Link | null>(null);
  const [statsFor, setStatsFor] = useState<Link | null>(null);

  // 정적 QR
  const [staticText, setStaticText] = useState("");

  useEffect(() => { setOrigin(window.location.origin); }, []);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/qr/links", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setLinks(j.links || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const shortUrl = (code: string) => `${origin}/q/${code}`;
  const qrSrc = (data: string, size = 200) => `/api/qr?data=${encodeURIComponent(data)}&size=${size}`;

  async function create() {
    if (!nTarget.trim()) { setError("목적지 URL 을 입력하세요."); return; }
    setCreating(true); setError("");
    try {
      const j = await (await fetch("/api/qr/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target_url: nTarget, title: nTitle, code: nCode }) })).json();
      if (!j.ok) throw new Error(j.error || "생성 실패");
      setNTarget(""); setNTitle(""); setNCode(""); load();
    } catch (e) { setError(e instanceof Error ? e.message : "생성 실패"); }
    setCreating(false);
  }
  async function toggleActive(l: Link) {
    setLinks((ls) => ls.map((x) => (x.id === l.id ? { ...x, active: !x.active } : x)));
    await fetch("/api/qr/links", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: l.id, active: !l.active }) });
  }
  async function remove(l: Link) {
    if (!confirm(`"${l.title || l.code}" 링크를 삭제할까요? QR도 더는 동작하지 않습니다.`)) return;
    await fetch(`/api/qr/links?id=${l.id}`, { method: "DELETE" });
    load();
  }
  function copy(text: string) { navigator.clipboard?.writeText(text); }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">QR 코드</h1>
          <p className="b2b-page-subtitle"><strong>동적 QR</strong>은 짧은 주소로 인코딩돼, 목적지를 나중에 바꿔도 같은 QR을 그대로 씁니다. 스캔 수도 집계돼요. <strong>정적 QR</strong>은 아무 URL/텍스트를 즉석에서 QR로.</p>
        </div>
      </header>

      <div className="sm-tabs" style={{ marginBottom: 16 }}>
        <button className={`sm-tab ${tab === "dynamic" ? "is-active" : ""}`} onClick={() => setTab("dynamic")}>동적 QR · 숏링크</button>
        <button className={`sm-tab ${tab === "static" ? "is-active" : ""}`} onClick={() => setTab("static")}>정적 QR</button>
      </div>

      {error && <div className="b2b-error">{error}</div>}

      {tab === "dynamic" && (
        <>
          <section className="b2b-card" style={{ marginBottom: 16 }}>
            <div className="b2b-card-head"><span className="b2b-card-title">새 링크 만들기</span></div>
            <div className="sm-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label className="b2b-field" style={{ flex: 2, minWidth: 220 }}><span className="b2b-field-label">목적지 URL</span>
                <input className="b2b-input" value={nTarget} onChange={(e) => setNTarget(e.target.value)} placeholder="https://예: 이벤트 페이지 주소" /></label>
              <label className="b2b-field" style={{ flex: 1, minWidth: 140 }}><span className="b2b-field-label">제목(선택)</span>
                <input className="b2b-input" value={nTitle} onChange={(e) => setNTitle(e.target.value)} placeholder="예: 6월 라방 QR" /></label>
              <label className="b2b-field" style={{ width: 150 }}><span className="b2b-field-label">커스텀 코드(선택)</span>
                <input className="b2b-input" value={nCode} onChange={(e) => setNCode(e.target.value)} placeholder="비우면 자동" /></label>
              <button className="b2b-btn-primary" onClick={create} disabled={creating} style={{ height: 40 }}>{creating ? "생성 중…" : "만들기"}</button>
            </div>
          </section>

          {loading ? <div className="b2b-loading">불러오는 중...</div> : links.length === 0 ? (
            <div className="b2b-empty"><div className="b2b-empty-icon">🔗</div>아직 만든 링크가 없습니다.{error.includes("short_links") || error.includes("relation") ? " — supabase/migrations/038_qr_short_links.sql 를 먼저 적용하세요." : ""}</div>
          ) : (
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead><tr><th></th><th>제목 · 짧은 주소</th><th>목적지</th><th className="num">스캔</th><th>상태</th><th></th></tr></thead>
                <tbody>
                  {links.map((l) => (
                    <tr key={l.id} style={{ opacity: l.active ? 1 : 0.55 }}>
                      <td style={{ width: 48 }}><img src={qrSrc(shortUrl(l.code), 96)} alt="QR" width={40} height={40} style={{ cursor: "pointer", borderRadius: 4 }} onClick={() => setQrFor(l)} /></td>
                      <td>
                        <strong>{l.title || l.code}</strong>
                        <div className="sm-row" style={{ gap: 6, marginTop: 2 }}>
                          <code style={{ fontSize: 12, color: "var(--sm-text-mid)" }}>/q/{l.code}</code>
                          <button className="b2b-link-btn" style={{ fontSize: 11 }} onClick={() => copy(shortUrl(l.code))}>복사</button>
                        </div>
                      </td>
                      <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><a href={l.target_url} target="_blank" rel="noreferrer" className="change-link" style={{ fontSize: 12 }}>{l.target_url}</a></td>
                      <td className="num b2b-money"><button className="b2b-link-btn" onClick={() => setStatsFor(l)} title="스캔 통계">{l.scan_count.toLocaleString()}</button></td>
                      <td><label className="sm-row" style={{ gap: 5, fontSize: 12, cursor: "pointer" }}><input type="checkbox" checked={l.active} onChange={() => toggleActive(l)} />{l.active ? "활성" : "비활성"}</label></td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className="b2b-btn-secondary" style={{ padding: "3px 8px", fontSize: 11 }} onClick={() => setEdit(l)}>수정</button>
                        <button className="b2b-link-btn" style={{ marginLeft: 8, color: "var(--sm-danger)" }} onClick={() => remove(l)}>삭제</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === "static" && (
        <section className="b2b-card">
          <div className="b2b-card-head"><span className="b2b-card-title">정적 QR 생성</span></div>
          <p className="sm-faint" style={{ fontSize: 12, marginBottom: 10 }}>URL·텍스트를 넣으면 그 값이 그대로 담긴 QR이 생성됩니다(저장 안 됨, 목적지 변경·통계 없음).</p>
          <input className="b2b-input" value={staticText} onChange={(e) => setStaticText(e.target.value)} placeholder="https://... 또는 아무 텍스트" style={{ maxWidth: 460 }} />
          {staticText.trim() && (
            <div className="sm-col" style={{ gap: 10, marginTop: 14, alignItems: "flex-start" }}>
              <img src={qrSrc(staticText.trim(), 240)} alt="QR" width={220} height={220} style={{ border: "1px solid var(--sm-border)", borderRadius: 8 }} />
              <div className="sm-row" style={{ gap: 8 }}>
                <a className="b2b-btn-secondary" href={`/api/qr?data=${encodeURIComponent(staticText.trim())}&size=1024&download=1&format=png`}>PNG 다운로드</a>
                <a className="b2b-btn-secondary" href={`/api/qr?data=${encodeURIComponent(staticText.trim())}&download=1&format=svg`}>SVG 다운로드</a>
              </div>
            </div>
          )}
        </section>
      )}

      {/* QR 크게 보기 + 다운로드 */}
      {qrFor && (
        <div className="b2b-modal-backdrop" onClick={() => setQrFor(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
            <div className="b2b-modal-head"><h2 className="b2b-modal-title">{qrFor.title || qrFor.code}</h2><button className="b2b-modal-close" onClick={() => setQrFor(null)}>✕</button></div>
            <div className="b2b-modal-body" style={{ textAlign: "center" }}>
              <img src={qrSrc(shortUrl(qrFor.code), 280)} alt="QR" width={260} height={260} style={{ border: "1px solid var(--sm-border)", borderRadius: 8 }} />
              <div className="sm-row" style={{ gap: 6, justifyContent: "center", marginTop: 10 }}>
                <code style={{ fontSize: 12 }}>{shortUrl(qrFor.code)}</code>
                <button className="b2b-link-btn" style={{ fontSize: 11 }} onClick={() => copy(shortUrl(qrFor.code))}>복사</button>
              </div>
              <div className="sm-row" style={{ gap: 8, justifyContent: "center", marginTop: 12 }}>
                <a className="b2b-btn-secondary" href={`/api/qr?data=${encodeURIComponent(shortUrl(qrFor.code))}&size=1024&download=1&format=png&name=${qrFor.code}`}>PNG</a>
                <a className="b2b-btn-secondary" href={`/api/qr?data=${encodeURIComponent(shortUrl(qrFor.code))}&download=1&format=svg&name=${qrFor.code}`}>SVG</a>
              </div>
            </div>
          </div>
        </div>
      )}

      {edit && <EditModal link={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {statsFor && <StatsModal link={statsFor} onClose={() => setStatsFor(null)} />}
    </div>
  );
}

function EditModal({ link, onClose, onSaved }: { link: Link; onClose: () => void; onSaved: () => void }) {
  const [target, setTarget] = useState(link.target_url);
  const [title, setTitle] = useState(link.title || "");
  const [code, setCode] = useState(link.code);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setSaving(true); setError("");
    try {
      const j = await (await fetch("/api/qr/links", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: link.id, target_url: target, title, code }) })).json();
      if (!j.ok) throw new Error(j.error || "저장 실패");
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }
  return (
    <div className="b2b-modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <div className="b2b-modal-head"><h2 className="b2b-modal-title">링크 수정</h2><button className="b2b-modal-close" onClick={onClose}>✕</button></div>
        <div className="b2b-modal-body">
          <div className="b2b-field"><label className="b2b-field-label">목적지 URL <span className="sm-faint" style={{ fontWeight: 400 }}>(바꿔도 QR은 그대로)</span></label><input className="b2b-input" value={target} onChange={(e) => setTarget(e.target.value)} /></div>
          <div className="b2b-field"><label className="b2b-field-label">제목</label><input className="b2b-input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="b2b-field"><label className="b2b-field-label">코드 <span className="sm-faint" style={{ fontWeight: 400 }}>(바꾸면 기존 QR은 무효)</span></label><input className="b2b-input" value={code} onChange={(e) => setCode(e.target.value)} /></div>
          {error && <div className="b2b-error" style={{ marginTop: 6 }}>{error}</div>}
        </div>
        <div className="b2b-modal-foot"><span /><div className="b2b-modal-foot-right"><button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>취소</button><button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중…" : "저장"}</button></div></div>
      </div>
    </div>
  );
}

function StatsModal({ link, onClose }: { link: Link; onClose: () => void }) {
  const [daily, setDaily] = useState<{ date: string; count: number }[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try { const j = await (await fetch(`/api/qr/scans?link=${link.id}`, { cache: "no-store" })).json(); if (j.ok) { setDaily(j.daily || []); setScans(j.scans || []); } } catch { /* noop */ }
      setLoading(false);
    })();
  }, [link.id]);
  const max = useMemo(() => Math.max(1, ...daily.map((d) => d.count)), [daily]);
  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="b2b-modal-head"><h2 className="b2b-modal-title">스캔 통계 — {link.title || link.code}</h2><button className="b2b-modal-close" onClick={onClose}>✕</button></div>
        <div className="b2b-modal-body">
          <p style={{ marginBottom: 10 }}>누적 스캔 <strong style={{ color: "var(--sm-orange)" }}>{link.scan_count.toLocaleString()}</strong>회 <span className="sm-faint" style={{ fontSize: 12 }}>(최근 500건 기준 일자·목록)</span></p>
          {loading ? <div className="b2b-loading">불러오는 중...</div> : (
            <>
              {daily.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div className="b2b-field-label" style={{ fontWeight: 700 }}>일자별</div>
                  <div className="sm-col" style={{ gap: 3, marginTop: 4 }}>
                    {daily.slice(-14).map((d) => (
                      <div key={d.date} className="sm-row" style={{ gap: 8, alignItems: "center" }}>
                        <span className="sm-faint" style={{ fontSize: 11, width: 74 }}>{d.date.slice(5)}</span>
                        <span style={{ height: 12, background: "var(--sm-orange)", borderRadius: 3, width: `${(d.count / max) * 60 + 8}%`, minWidth: 8 }} />
                        <span style={{ fontSize: 12 }}>{d.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="b2b-field-label" style={{ fontWeight: 700 }}>최근 스캔</div>
              {scans.length === 0 ? <div className="sm-faint" style={{ fontSize: 12, padding: "6px 0" }}>아직 스캔 기록이 없습니다.</div> : (
                <div className="b2b-table-wrap" style={{ maxHeight: 240, overflow: "auto", marginTop: 4 }}>
                  <table className="b2b-table"><thead><tr><th>시각</th><th>국가</th><th>유입</th></tr></thead>
                    <tbody>{scans.slice(0, 100).map((s, i) => (
                      <tr key={i}><td style={{ whiteSpace: "nowrap", fontSize: 12 }}>{new Date(new Date(s.scanned_at).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ")}</td><td>{s.country || "-"}</td><td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }} className="sm-faint">{s.referer || "직접"}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
