"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { MarginResult, MarginResultItem, MarginTurn } from "@/app/lib/margin-calc";
import { won as fmtWon } from "@/app/lib/format";

const won = (n: number) => `${fmtWon(n)}원`;

type Saved = { id: string; name: string; question: string; createdAt: string; createdBy?: string | null };

// 질문 조립 도우미 — 칸을 클릭하면 시나리오 문장이 만들어져 질문칸에 채워짐(상품명은 직접 입력).
const PRICE_OPTS = ["정가로", "10% 할인으로", "20% 할인으로", "30% 할인으로", "도매가로", "1+1로"];
const ASK_OPTS = ["팔면 이익률이 어때?", "팔면 순이익은 얼마야?", "몇 %까지 할인해도 남아?", "손익분기 판매가는 얼마야?"];

function QuestionComposer({ channels, disabled, onCompose }: { channels: string[]; disabled: boolean; onCompose: (text: string) => void }) {
  const [open, setOpen] = useState(true);
  const [pick, setPick] = useState<Record<string, string>>({});
  const FACETS = [
    { key: "channel", label: "채널", opts: channels },
    { key: "price", label: "가격 조건", opts: PRICE_OPTS },
    { key: "ask", label: "질문", opts: ASK_OPTS },
  ];
  const compose = (p: Record<string, string>) =>
    [p.channel ? `${p.channel}에서` : "", p.price || "", p.ask || ""].filter(Boolean).join(" ");
  function toggle(key: string, opt: string) {
    const next = { ...pick };
    if (next[key] === opt) delete next[key]; else next[key] = opt;
    setPick(next);
    onCompose(compose(next));
  }
  function reset() { setPick({}); onCompose(""); }
  return (
    <div className="rp-compose">
      <button className="rp-compose-head" onClick={() => setOpen((v) => !v)}>
        <span>{open ? "▾" : "▸"} 질문 만들기 도우미</span>
        <span className="rp-compose-hint">칸을 눌러 조합한 뒤, 질문칸 맨 앞에 상품명(예: 대구순살 1kg)을 붙여주세요.</span>
      </button>
      {open && (
        <div className="rp-compose-body">
          {FACETS.filter((f) => f.opts.length > 0).map((f) => (
            <div key={f.key} className="rp-compose-row">
              <span className="rp-compose-label">{f.label}</span>
              <div className="rp-compose-chips">
                {f.opts.map((o) => (
                  <button key={o} type="button" className={`rp-chip ${pick[f.key] === o ? "is-active" : ""}`} disabled={disabled} onClick={() => toggle(f.key, o)}>{o}</button>
                ))}
              </div>
            </div>
          ))}
          {Object.keys(pick).length > 0 && <button className="b2b-link-btn" style={{ fontSize: 13 }} onClick={reset}>선택 초기화</button>}
        </div>
      )}
    </div>
  );
}

export default function MarginCalcPage() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [res, setRes] = useState<MarginResult | null>(null);
  const [turns, setTurns] = useState<MarginTurn[]>([]);
  const [channels, setChannels] = useState<string[]>([]);

  // 저장된 계산
  const [saved, setSaved] = useState<Saved[]>([]);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedFilter, setSavedFilter] = useState<"mine" | "all">("mine");
  const [me, setMe] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveQuestion, setSaveQuestion] = useState("");

  // 프롬프트(계산 지침) 설정 — 접이식, 처음 펼칠 때 로드.
  const [pOpen, setPOpen] = useState(false);
  const [pLoaded, setPLoaded] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [promptDefault, setPromptDefault] = useState("");
  const [promptIsDefault, setPromptIsDefault] = useState(true);
  const [pSaving, setPSaving] = useState(false);
  const [pSaved, setPSaved] = useState("");
  const [pError, setPError] = useState("");

  const loadSaved = useCallback(async () => {
    try { const j = await (await fetch("/api/sales/margin-calc/saved", { cache: "no-store" })).json(); if (j.ok) setSaved(j.saved || []); } catch { /* noop */ }
  }, []);
  useEffect(() => { loadSaved(); }, [loadSaved]);
  useEffect(() => { (async () => { try { const j = await (await fetch("/api/b2b/auth", { cache: "no-store" })).json(); if (j.ok) setMe(j.name); } catch { /* noop */ } })(); }, []);
  useEffect(() => { (async () => { try { const j = await (await fetch("/api/sales/margin-calc", { cache: "no-store" })).json(); if (j.ok) setChannels(j.channels || []); } catch { /* noop */ } })(); }, []);

  const filteredSaved = useMemo(
    () => (savedFilter === "all" || !me ? saved : saved.filter((s) => s.createdBy === me)),
    [saved, savedFilter, me],
  );

  async function run(question?: string, fresh = false) {
    const text = (question ?? q).trim();
    if (!text || loading) return;
    const hist = fresh ? [] : turns;
    setLoading(true); setError(""); setRes(null);
    if (fresh) setTurns([]);
    try {
      const r = await fetch("/api/sales/margin-calc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text, history: hist }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "분석 실패");
      setRes(j.result as MarginResult);
      setTurns([...hist, { q: text, result: j.result as MarginResult }]);
      setQ("");
    } catch (e) { setError(e instanceof Error ? e.message : "분석 실패"); }
    setLoading(false);
  }

  function newThread() { setTurns([]); setRes(null); setError(""); setQ(""); }

  function openSave() {
    const joined = turns.map((t) => t.q).join(" — 이어서: ");
    setSaveName((res?.scenario || joined).slice(0, 40));
    setSaveQuestion(joined);
    setSaveOpen(true);
  }
  async function doSave() {
    if (!saveName.trim() || !saveQuestion.trim()) return;
    const r = await fetch("/api/sales/margin-calc/saved", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: saveName.trim(), question: saveQuestion.trim() }) });
    const j = await r.json();
    if (!j.ok) { setError(j.error || "저장 실패"); return; }
    setSaveOpen(false); loadSaved();
  }
  async function delSaved(id: string) {
    await fetch(`/api/sales/margin-calc/saved?id=${id}`, { method: "DELETE" }); loadSaved();
  }

  async function togglePrompt() {
    const next = !pOpen;
    setPOpen(next);
    if (next && !pLoaded) {
      setPError("");
      try {
        const r = await fetch("/api/sales/margin-calc/prompt", { cache: "no-store" });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || "조회 실패");
        setPrompt(j.prompt || ""); setPromptDefault(j.default || ""); setPromptIsDefault(!!j.isDefault);
        setPLoaded(true);
      } catch (e) { setPError(e instanceof Error ? e.message : "조회 실패"); }
    }
  }

  async function savePrompt(next?: string) {
    const body = next !== undefined ? next : prompt;
    setPSaving(true); setPError(""); setPSaved("");
    try {
      const r = await fetch("/api/sales/margin-calc/prompt", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: body }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setPrompt(j.prompt || ""); setPromptIsDefault(!!j.isDefault);
      const d = new Date();
      setPSaved(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 저장됨`);
    } catch (e) { setPError(e instanceof Error ? e.message : "저장 실패"); }
    setPSaving(false);
  }

  function resetPrompt() {
    if (!confirm("계산 지침을 기본값으로 되돌릴까요? 저장한 내용은 사라집니다.")) return;
    setPrompt(promptDefault);
    savePrompt(""); // 빈 값 저장 → 서버에서 설정 삭제(기본값 복원)
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">이익률 계산기 <span className="mc-ai">AI</span></h1>
        </div>
      </header>

      {/* 저장된 계산 — 기본 접힘, 클릭 실행 */}
      {saved.length > 0 && (
        <div className="rp-saved-box">
          <div className="rp-saved-bar">
            <button className="rp-saved-toggle" onClick={() => setSavedOpen((v) => !v)}>
              <span className="rp-saved-chev">{savedOpen ? "▾" : "▸"}</span>
              저장된 계산 <span className="rp-saved-count">{filteredSaved.length}개{savedFilter === "mine" && me ? " · 내 저장" : ""}</span>
            </button>
            {savedOpen && me && (
              <div className="sm-tabs">
                <button className={`sm-tab ${savedFilter === "mine" ? "is-active" : ""}`} onClick={() => setSavedFilter("mine")}>내 저장</button>
                <button className={`sm-tab ${savedFilter === "all" ? "is-active" : ""}`} onClick={() => setSavedFilter("all")}>전체</button>
              </div>
            )}
          </div>
          {savedOpen && (filteredSaved.length === 0 ? (
            <div className="b2b-empty" style={{ padding: 16 }}>{savedFilter === "mine" ? "내가 저장한 계산이 없습니다. ‘전체’로 바꿔보세요." : "저장된 계산이 없습니다."}</div>
          ) : (
            <div className="rp-saved-list">
              {filteredSaved.map((s) => (
                <div key={s.id} className="rp-saved-item" onClick={() => { if (!loading) run(s.question, true); }} title="클릭하면 현재 원가·수수료 기준으로 다시 계산">
                  <span className="rp-saved-name">{s.name}</span>
                  <div className="rp-saved-q">{s.question}</div>
                  <div className="rp-saved-meta">
                    <span>저장: {s.createdBy || "—"}</span>
                    <span>·</span>
                    <span>{s.createdAt.slice(0, 10)}</span>
                    <button className="rp-saved-del2" onClick={(e) => { e.stopPropagation(); delSaved(s.id); }}>삭제</button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* 이어지는 대화 표시 */}
      {turns.length > 0 && (
        <div className="rp-thread">
          <span>이어지는 계산</span>
          {turns.map((t, i) => <span key={i} className="rp-thread-q">{t.q}</span>)}
        </div>
      )}

      <QuestionComposer channels={channels} disabled={loading} onCompose={setQ} />

      <div className="rp-ask">
        <textarea className="b2b-input rp-input" rows={2} value={q}
          placeholder={turns.length ? "이어서: 택배비를 4,000원으로 바꾸면? / 30% 할인이면? / 스마트스토어와 비교해줘" : "예: 대구순살 1kg을 20% 할인가로 쿠팡에서 판매하면 이익률이 어때?"}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }} />
        <div className="rp-ask-actions">
          <button className="b2b-btn-primary" onClick={() => run()} disabled={loading || !q.trim()}>
            {loading ? "분석 중…" : turns.length ? "이어서 질문" : "분석하기"}
            <span className="rp-kbd">Ctrl+Enter</span>
          </button>
          {turns.length > 0 && (
            <button className="b2b-btn-secondary" onClick={newThread} disabled={loading}>새 계산 시작</button>
          )}
        </div>
      </div>

      {error && <div className="b2b-error" style={{ marginBottom: 12 }}>{error}</div>}
      {loading && <div className="b2b-loading">원가표·정책을 근거로 계산 중… (최고급 모델, 10~20초)</div>}

      {res && !loading && (
        <div className="sm-col" style={{ gap: 14 }}>
          <div className="rp-understood">
            {res.scenario}{res.product ? <> · 상품: <strong>{res.product}</strong></> : null}
            {res.results.length > 0 && (
              <button className="b2b-btn-secondary" style={{ padding: "4px 10px", marginLeft: 10, fontSize: 12.5 }} onClick={openSave}>저장</button>
            )}
          </div>

          {res.results.map((r, i) => <ResultCard key={i} r={r} />)}

          {res.strategy && (
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">판매 전략 제언</span></div>
              <div style={{ fontSize: 13.5, lineHeight: 1.75, whiteSpace: "pre-wrap", color: "var(--sm-text-mid)" }}>{res.strategy.replace(/\*\*/g, "")}</div>
            </section>
          )}

          {res.assumptions?.length > 0 && (
            <div className="sm-faint" style={{ fontSize: 12, lineHeight: 1.7 }}>
              <strong>가정·주의</strong>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{res.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </div>
          )}

          <p className="sm-faint" style={{ fontSize: 11.5 }}>※ 원가·수수료·배송정책 데이터를 근거로 한 추정입니다. 실제 정산과 차이가 있을 수 있어요.</p>
        </div>
      )}

      {/* 저장 다이얼로그 */}
      {saveOpen && (
        <div className="rp-modal-bg" onClick={() => setSaveOpen(false)}>
          <div className="rp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="b2b-card-head"><span className="b2b-card-title">계산 저장</span></div>
            <label className="sm-col" style={{ gap: 4, marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>이름</span>
              <input className="b2b-input" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="예: 대구 1kg 쿠팡 20% 할인" />
            </label>
            <label className="sm-col" style={{ gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>질문 <span className="sm-faint" style={{ fontWeight: 400 }}>— 실행할 때마다 이 질문을 현재 원가·수수료 기준으로 다시 계산합니다</span></span>
              <textarea className="b2b-input" style={{ minHeight: 90, fontSize: 13, lineHeight: 1.6 }} value={saveQuestion} onChange={(e) => setSaveQuestion(e.target.value)} />
            </label>
            <div className="sm-row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="b2b-btn-secondary" onClick={() => setSaveOpen(false)}>취소</button>
              <button className="b2b-btn-primary" onClick={doSave} disabled={!saveName.trim() || !saveQuestion.trim()}>저장</button>
            </div>
          </div>
        </div>
      )}

      {/* 프롬프트(계산 지침) 설정 — 접이식 */}
      <section className="b2b-card" style={{ marginTop: 24 }}>
        <button type="button" className="mc-prompt-toggle" onClick={togglePrompt} aria-expanded={pOpen}>
          <span>프롬프트 설정 <span className="sm-faint" style={{ fontWeight: 400 }}>· 계산 규칙 · 배송/보냉비 단가</span></span>
          <span className="sm-faint" style={{ fontSize: 12 }}>{pOpen ? "접기 ▲" : "펼치기 ▼"}</span>
        </button>

        {pOpen && (
          <div style={{ marginTop: 14 }}>
            <p className="sm-faint" style={{ fontSize: 12, lineHeight: 1.7, margin: "0 0 12px" }}>
              이익률 계산기의 <strong>역할·계산 규칙·배송 단가/보냉비 정책</strong>을 정의하는 지침입니다. 여기서 바꾸면 코드 수정·재배포 없이 즉시 반영됩니다.
              <br />
              원가표·채널 수수료는 <Link href="/b2b/products">상품 마스터</Link>·<Link href="/sales/profit">채널별 이익 설정</Link>에서 관리하고, <strong>출력 형식(JSON)</strong>은 시스템이 자동으로 덧붙이므로 여기에 넣지 마세요.
            </p>

            {pError && <div className="b2b-error" style={{ marginBottom: 10 }}>{pError}</div>}

            {!pLoaded ? (
              <div className="b2b-loading">불러오는 중…</div>
            ) : (
              <>
                <textarea
                  className="b2b-input"
                  value={prompt}
                  onChange={(e) => { setPrompt(e.target.value); setPSaved(""); }}
                  spellCheck={false}
                  style={{ width: "100%", minHeight: 340, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12.5, lineHeight: 1.7, resize: "vertical", whiteSpace: "pre", overflowWrap: "normal", overflowX: "auto" }}
                />
                <div className="sm-row" style={{ gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <button className="b2b-btn-primary" onClick={() => savePrompt()} disabled={pSaving}>{pSaving ? "저장 중…" : "지침 저장"}</button>
                  <button className="b2b-btn-secondary" onClick={resetPrompt} disabled={pSaving || promptIsDefault}>기본값으로 복원</button>
                  {pSaved && <span style={{ fontSize: 12, color: "var(--sm-success)" }}>{pSaved}</span>}
                  <span className="sm-faint" style={{ fontSize: 11.5, marginLeft: "auto" }}>
                    {prompt.length.toLocaleString()}자 · <span style={{ color: promptIsDefault ? "var(--sm-text-light)" : "var(--sm-orange)" }}>{promptIsDefault ? "기본값" : "사용자 지정"}</span> · 모든 사용자 공용
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <style>{`
        .mc-ai { font-size: 11px; font-weight: 700; color: var(--sm-orange); border: 1px solid var(--sm-orange-border); background: var(--sm-orange-light); border-radius: 6px; padding: 1px 7px; vertical-align: middle; margin-left: 4px; }
        .mc-prompt-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; background: none; border: none; padding: 0; cursor: pointer; font-size: 14px; font-weight: 600; color: var(--sm-text-mid); text-align: left; }
      `}</style>
    </div>
  );
}

function ResultCard({ r }: { r: MarginResultItem }) {
  const positive = r.netProfit >= 0;
  // 좋은 값 = success (매출 대시보드의 증감 배지와 같은 색 언어 — 주황은 브랜드 강조지 시맨틱이 아님)
  const emph = positive ? "var(--sm-success)" : "var(--sm-danger)";
  return (
    <section className="b2b-card">
      <div className="b2b-card-head"><span className="b2b-card-title">{r.label}</span></div>

      {/* 강조: 순이익 · 이익률 */}
      <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 14 }}>
        <div className="b2b-stat-card" style={{ borderColor: emph, background: "var(--sm-orange-light)" }}>
          <div className="b2b-stat-card-label">순이익</div>
          <div className="b2b-stat-card-value" style={{ color: emph }}>{won(r.netProfit)}</div>
        </div>
        <div className="b2b-stat-card" style={{ borderColor: emph, background: "var(--sm-orange-light)" }}>
          <div className="b2b-stat-card-label">이익률</div>
          <div className="b2b-stat-card-value" style={{ color: emph }}>{(Number(r.marginPct) || 0).toFixed(1)}%</div>
        </div>
      </div>

      {/* 투명한 계산 근거 */}
      <div className="b2b-table-wrap">
        <table className="b2b-table" style={{ fontSize: 13 }}>
          <tbody>
            <tr>
              <td><strong>매출액</strong> <span className="sm-faint" style={{ fontSize: 11 }}>(고객 결제가)</span></td>
              <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(r.revenue)}</td>
            </tr>
            {r.supplyValue > 0 && r.supplyValue !== r.revenue && (
              <tr>
                <td className="sm-faint">└ 공급가액 <span style={{ fontSize: 11 }}>(부가세 차감)</span></td>
                <td className="num b2b-money sm-faint">{won(r.supplyValue)}</td>
              </tr>
            )}
            {r.expenses.map((e, i) => (
              <tr key={i}>
                <td style={{ color: "var(--sm-text-mid)" }}>− {e.label}{e.note ? <span className="sm-faint" style={{ fontSize: 11 }}> · {e.note}</span> : null}</td>
                <td className="num b2b-money" style={{ color: "var(--sm-danger)" }}>−{won(e.amount)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: "2px solid var(--sm-border)" }}>
              <td><strong>순이익</strong></td>
              <td className="num b2b-money" style={{ fontWeight: 800, color: emph }}>{won(r.netProfit)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {r.taxNote && <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>{r.taxNote}</p>}
    </section>
  );
}
