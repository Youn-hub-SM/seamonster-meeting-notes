"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Format = "영상" | "이미지";
type Creative = {
  id: string; name: string; format: Format; hook: string; story: string; offer: string;
  adLibraryUrl: string; note?: string; roas?: number; spend?: number; purchases?: number; sourceAdId?: string; createdAt: string;
};

const EMPTY = { name: "", format: "영상" as Format, hook: "", story: "", offer: "", adLibraryUrl: "", note: "", roas: "" as string };

export default function MetaLibraryPage() {
  const [f, setF] = useState({ ...EMPTY });
  const [sourceAdId, setSourceAdId] = useState("");
  const [list, setList] = useState<Creative[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try { const j = await (await fetch("/api/meta-ad/creatives", { cache: "no-store" })).json(); if (j.ok) setList(j.creatives || []); }
    catch { /* noop */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // 보드에서 '라이브러리 저장'으로 넘어온 경우 폼 프리필(name·roas·adid·url)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if ([...p.keys()].length === 0) return;
    setF((prev) => ({ ...prev, name: p.get("name") || prev.name, roas: p.get("roas") || prev.roas, adLibraryUrl: p.get("adurl") || prev.adLibraryUrl }));
    if (p.get("adid")) setSourceAdId(p.get("adid")!);
    const spend = p.get("spend"), purch = p.get("purchases");
    if (spend || purch) setPrefillMetrics({ spend: spend ? Number(spend) : undefined, purchases: purch ? Number(purch) : undefined });
  }, []);
  const [prefillMetrics, setPrefillMetrics] = useState<{ spend?: number; purchases?: number }>({});

  const set = (k: keyof typeof EMPTY, v: string) => setF((prev) => ({ ...prev, [k]: v }));

  async function save() {
    setErr(""); setMsg("");
    const miss = [!f.name.trim() && "이름", !f.hook.trim() && "후킹", !f.story.trim() && "스토리", !f.offer.trim() && "제안"].filter(Boolean);
    if (miss.length) { setErr(`${miss.join("·")} 을(를) 채워주세요. (모든 소재는 후킹+스토리+제안 3요소 필수)`); return; }
    setSaving(true);
    try {
      const body = { ...f, roas: f.roas ? Number(f.roas) : undefined, sourceAdId, ...prefillMetrics };
      const j = await (await fetch("/api/meta-ad/creatives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
      if (!j.ok) throw new Error(j.error);
      setMsg("✅ 저장됨"); setF({ ...EMPTY }); setSourceAdId(""); setPrefillMetrics({}); load();
    } catch (e) { setErr(e instanceof Error ? e.message : "저장 오류"); }
    setSaving(false);
  }
  async function del(id: string) {
    if (!window.confirm("이 소재를 삭제할까요?")) return;
    await fetch(`/api/meta-ad/creatives?id=${id}`, { method: "DELETE" }); load();
  }
  function reuse(c: Creative) {
    setF({ name: `${c.name} (재사용)`, format: c.format, hook: c.hook, story: c.story, offer: c.offer, adLibraryUrl: c.adLibraryUrl, note: c.note || "", roas: "" });
    setSourceAdId(""); setPrefillMetrics({}); setMsg(""); setErr("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">메타 소재 라이브러리</h1>
          <p className="b2b-page-subtitle">잘 나온 소재를 <b>후킹·스토리·제안</b> 3요소로 기획·아카이빙해 재사용합니다. 이미지·영상은 <b>광고 라이브러리 링크</b>로 확인(업로드 없음). <Link href="/meta-ad">← 보드로</Link></p>
        </div>
      </header>

      {/* 기획 폼 */}
      <section className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">➕ 소재 기획</span></div>
        <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          <label className="sm-col" style={{ gap: 3, flex: "2 1 220px" }}>
            <span className="mlib-lbl">소재 이름 / 컨셉</span>
            <input className="b2b-input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="예: 대구살 이유식 후기형 15초" />
          </label>
          <label className="sm-col" style={{ gap: 3 }}>
            <span className="mlib-lbl">유형</span>
            <div className="sm-row" style={{ gap: 6 }}>
              {(["영상", "이미지"] as Format[]).map((t) => (
                <button key={t} type="button" onClick={() => set("format", t)}
                  style={{ fontSize: 12, padding: "7px 14px", borderRadius: 8, cursor: "pointer", fontWeight: f.format === t ? 700 : 500, border: f.format === t ? "1px solid var(--sm-orange)" : "1px solid var(--sm-border)", background: f.format === t ? "var(--sm-orange-light)" : "var(--sm-white)", color: f.format === t ? "var(--sm-orange-hover)" : "var(--sm-text-mid)" }}>{t}</button>
              ))}
            </div>
          </label>
          <label className="sm-col" style={{ gap: 3, flex: "2 1 260px" }}>
            <span className="mlib-lbl">광고 라이브러리 URL <span className="sm-faint">(이미지·영상 확인용)</span></span>
            <input className="b2b-input" value={f.adLibraryUrl} onChange={(e) => set("adLibraryUrl", e.target.value)} placeholder="https://www.facebook.com/ads/library/?id=..." />
          </label>
        </div>

        {/* 3요소 필수 */}
        <div className="mlib-3">
          <div className="mlib-el">
            <div className="mlib-el-h"><span className="mlib-num" style={{ background: "#4c6ef5" }}>①</span> 후킹 <span className="sm-faint">첫 1~3초 · 시선 잡기</span></div>
            <textarea className="b2b-input" value={f.hook} onChange={(e) => set("hook", e.target.value)} placeholder="예: '닭가슴살 질린 분?' / 충격적 비주얼 / 질문 던지기" rows={3} />
          </div>
          <div className="mlib-el">
            <div className="mlib-el-h"><span className="mlib-num" style={{ background: "#f76707" }}>②</span> 스토리 <span className="sm-faint">문제→공감→해결 전개</span></div>
            <textarea className="b2b-input" value={f.story} onChange={(e) => set("story", e.target.value)} placeholder="예: 다이어트 단백질 고민 → 생선살로 해결 → 조리 간편함 시연" rows={3} />
          </div>
          <div className="mlib-el">
            <div className="mlib-el-h"><span className="mlib-num" style={{ background: "#2f9e44" }}>③</span> 제안 <span className="sm-faint">혜택 · CTA · 구매 유도</span></div>
            <textarea className="b2b-input" value={f.offer} onChange={(e) => set("offer", e.target.value)} placeholder="예: 첫 구매 20% + 무료배송 / '지금 맛보기 담기'" rows={3} />
          </div>
        </div>

        <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
          <label className="sm-col" style={{ gap: 3, flex: "3 1 240px" }}>
            <span className="mlib-lbl">메모 <span className="sm-faint">(선택)</span></span>
            <input className="b2b-input" value={f.note} onChange={(e) => set("note", e.target.value)} placeholder="타깃·배경·러닝 등" />
          </label>
          <label className="sm-col" style={{ gap: 3 }}>
            <span className="mlib-lbl">참고 ROAS <span className="sm-faint">(선택)</span></span>
            <input className="b2b-input b2b-money" style={{ width: 110, textAlign: "right" }} type="number" step={0.1} value={f.roas} onChange={(e) => set("roas", e.target.value)} placeholder="예: 3.2" />
          </label>
          <div style={{ flex: 1 }} />
          {msg && <span style={{ fontSize: 12, color: "var(--sm-success)" }}>{msg}</span>}
          <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중..." : "라이브러리에 저장"}</button>
        </div>
        {err && <div className="b2b-error" style={{ marginTop: 10 }}>{err}</div>}
      </section>

      {/* 저장된 소재 */}
      <div className="b2b-card-head" style={{ marginBottom: 10 }}><span className="b2b-card-title">저장된 소재 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 12 }}>{list.length}개</span></span></div>
      {loading ? <div className="b2b-loading">불러오는 중...</div> : list.length === 0 ? (
        <div className="b2b-empty"><div className="b2b-empty-icon">🎬</div>아직 저장된 소재가 없습니다. 위에서 기획해 저장하거나, 보드에서 우수 소재를 저장하세요.</div>
      ) : (
        <div className="mlib-grid">
          {list.map((c) => (
            <div key={c.id} className="mlib-card">
              <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--sm-dark)" }}>{c.name}</div>
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 6, background: c.format === "영상" ? "#4c6ef51a" : "#2f9e441a", color: c.format === "영상" ? "#4c6ef5" : "#2f9e44", whiteSpace: "nowrap" }}>{c.format}</span>
              </div>
              {(c.roas || c.adLibraryUrl) && (
                <div className="sm-row" style={{ gap: 8, marginTop: 5, fontSize: 11.5, flexWrap: "wrap", alignItems: "center" }}>
                  {c.roas ? <span className="sm-faint">ROAS <b style={{ color: "var(--sm-orange)" }}>{c.roas.toFixed(2)}</b></span> : null}
                  {c.adLibraryUrl ? <a href={c.adLibraryUrl} target="_blank" rel="noreferrer" style={{ color: "var(--sm-info)", fontSize: 11.5 }}>🔗 소재 보기</a> : null}
                </div>
              )}
              <div className="mlib-el3">
                <div><span className="mlib-tag" style={{ color: "#4c6ef5" }}>후킹</span> {c.hook}</div>
                <div><span className="mlib-tag" style={{ color: "#f76707" }}>스토리</span> {c.story}</div>
                <div><span className="mlib-tag" style={{ color: "#2f9e44" }}>제안</span> {c.offer}</div>
              </div>
              {c.note && <div className="sm-faint" style={{ fontSize: 11.5, marginTop: 6 }}>📝 {c.note}</div>}
              <div className="sm-row" style={{ gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
                <button className="b2b-link-btn" style={{ fontSize: 11.5 }} onClick={() => reuse(c)}>재사용(복제)</button>
                <button className="b2b-link-btn" style={{ fontSize: 11.5, color: "var(--sm-orange)" }} onClick={() => del(c.id)}>삭제</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
