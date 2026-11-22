"use client";

// 오디언스 추출 — 조건으로 고객을 찾아 이름·전화번호를 엑셀로 내려받는다.
//  찾은 고객에게 정해 둔 알림톡을 바로 보낼 수 있다([알림톡 보내기] — AlimtalkSend.tsx, 2026-11-20). 발송도 아래 기록에 남는다.
//  고객 전화번호가 밖으로 나가는 유일한 화면이라, 검색과 추출이 모두 아래 기록에 남고 누구에게나 보인다.
//  [고객 찾기] = 인원과 미리보기 10명(이름·번호 가림) → [엑셀 내려받기] = 방금 찾은 조건 그대로.
//  위 탭으로 대상을 고른다: 구매 고객(이 파일의 조건) / 정기배송 고객(SubAudience.tsx — 상태·회차·결제 예정일 등). 기록과 [다시 추출]은 둘이 함께 쓴다.
//
//  ■ 구매 고객 조건 = 조건 묶음(GroupCard.tsx) 여러 개(2026-11-22 대표: "and or 등을 넣어 고도화한 필터링, 이해하기 쉽게").
//    묶음 하나 = 주문의 범위(구매 기간·채널·상품) + 그 범위에서 센 주문 횟수·금액. 카드 머리에 넣은 조건을 한 줄로 읽어 준다.
//    묶음 사이는 [그리고](모두 맞는 고객) 또는 [또는](하나라도 맞는 고객) 중 하나 — 한 번의 검색에서 섞지 않는다.
//    [제외 조건] = 그 묶음에 맞는 고객을 뺀다. 묶음은 찾는 것·빼는 것 각각 MAX_GROUPS 개까지(서버와 같은 값).
import { useCallback, useEffect, useRef, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import SubAudience from "./SubAudience";
import TallyExclude, { tallyText, type ExForm, type TallyStat } from "./TallyExclude";
import AlimtalkSend, { SendHistory, type SendRow } from "./AlimtalkSend";
import GroupCard, { EMPTY_G, isEmptyG, toGroupPayload, type G, type ProductOption, type NameOption } from "./GroupCard";
import { qty, won, dateTime } from "@/app/lib/format";

const MAX_GROUPS = 5;
type Match = "all" | "any";
type Preview = { name: string; phone: string; orders: number; amount: number; groups?: ({ orders: number; amount: number } | null)[]; first_date: string; last_date: string; items: string; codes: string; channels: string };
type Result = { count: number; excluded: number; capped: boolean; max: number; summary: string; preview: Preview[]; payload: unknown; tally?: TallyStat | null };
type History = { id: string | number; action: "검색" | "추출"; cond: string; count: number | null; actor: string | null; created_at: string; again?: boolean; saved?: Record<string, unknown> | null };
const MARK = ["①", "②", "③", "④", "⑤"]; // 미리보기에서 조건 묶음을 가리키는 표시

export default function AudiencePage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [groups, setGroups] = useState<G[]>([EMPTY_G]);   // 찾는 조건 묶음(늘 하나 이상)
  const [excludes, setExcludes] = useState<G[]>([]);      // 빼는 조건 묶음
  const [match, setMatch] = useState<Match>("all");       // 묶음 사이 — 그리고 / 또는
  const [excludeForms, setExcludeForms] = useState<ExForm[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [sends, setSends] = useState<SendRow[] | null>(null); // 알림톡 발송 기록(표가 아직 없으면 null)
  const [canSend, setCanSend] = useState(false);              // 알림톡을 보낼 수 있는가(서버가 알려 준다 — 지금은 내부 직원 누구나)
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"" | "search" | "export">("");
  const [mode, setMode] = useState<"buy" | "sub">("buy"); // 누구를 뽑을지 — 구매 고객(매출 주문 조건) / 정기배송 고객(정기배송 상태 조건)
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<ProductOption[] | null>(null); // 상품 칸을 처음 누를 때 한 번 읽는다
  const [orderNames, setOrderNames] = useState<NameOption[]>([]);         // 주문서에 적힌 상품명(채널마다 다르다)
  const [productsError, setProductsError] = useState("");
  const productsAsked = useRef(false);

  const load = useCallback(async () => {
    try {
      const j = await (await fetch("/api/audience", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error);
      setChannels(j.channels || []); setHistory(j.history || []); setSends(j.sends ?? null); setCanSend(!!j.canSend); setLoadError("");
    } catch (e) { setLoadError(e instanceof Error ? e.message : "오디언스 기록을 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadProducts = () => {
    if (productsAsked.current) return;
    productsAsked.current = true;
    fetch("/api/audience?products=1", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!j.ok) throw new Error(j.error);
      setProducts(j.products || []); setOrderNames(j.names || []);
    }).catch((e) => { productsAsked.current = false; setProductsError(e instanceof Error ? e.message : "상품 목록을 불러오지 못했습니다."); });
  };

  const setGroup = (i: number, g: G) => setGroups((a) => a.map((x, k) => (k === i ? g : x)));
  const setExclude = (i: number, g: G) => setExcludes((a) => a.map((x, k) => (k === i ? g : x)));
  const filled = groups.filter((g) => !isEmptyG(g));
  const isBlank = filled.length === 0 && excludes.length === 0 && excludeForms.length === 0 && groups.length === 1;
  // 서버로 보내는 조건 — 맨 위 칸이 조건 1, more 가 조건 2부터(서버 app/lib/audience.ts AudienceCond)
  const buildPayload = () => {
    const [first, ...rest] = filled.map(toGroupPayload);
    return { ...(first || {}), more: rest, match: match === "any" && rest.length ? "any" : undefined, excludes: excludes.filter((g) => !isEmptyG(g)).map(toGroupPayload), excludeForms };
  };
  const reset = () => { setGroups([EMPTY_G]); setExcludes([]); setMatch("all"); setExcludeForms([]); setResult(null); setError(""); };

  const search = async () => {
    setError("");
    if (!filled.length) { setError("조건을 하나 이상 입력하세요."); return; } // 제외 조건·응답자 빼기만으로는 찾을 수 없다
    const payload = buildPayload();
    setBusy("search");
    try {
      const j = await (await fetch("/api/audience", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "search", cond: payload }) })).json();
      if (!j.ok) throw new Error(j.error);
      setResult({ ...j, payload });
      load();
    } catch (e) { setResult(null); setError(e instanceof Error ? e.message : "고객을 찾지 못했습니다."); }
    finally { setBusy(""); }
  };

  // 엑셀 받기 — 방금 찾은 조건(payload) 또는 기록의 조건(fromLog)으로. 어느 쪽이든 서버가 추출 기록을 새로 남긴다.
  const download = async (payload: unknown, fromLog?: string | number) => {
    setBusy("export");
    try {
      const res = await fetch("/api/audience", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "export", cond: payload, fromLog }) });
      if (!res.ok || !(res.headers.get("content-type") || "").includes("spreadsheet")) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "엑셀을 만들지 못했습니다."); }
      const n = res.headers.get("X-Audience-Count") || "0";
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `오디언스_${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "")}_${n}명.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      toast.success(`${qty(Number(n))}명을 엑셀로 내려받았습니다`);
      load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "엑셀을 만들지 못했습니다."); }
    finally { setBusy(""); }
  };
  const exportXlsx = async () => {
    if (!result) return;
    if (!(await confirm({ title: "엑셀 내려받기", body: `${qty(result.count)}명의 이름과 전화번호가 든 엑셀을 내려받습니다. 추출 기록에 남습니다.`, action: "엑셀 내려받기", danger: false }))) return;
    await download(result.payload);
  };
  // 기록의 조건으로 다시 추출 — 명단은 저장하지 않으므로 같은 조건을 지금 데이터로 다시 조회한다(인원이 그때와 다를 수 있다)
  const reExport = async (h: History) => {
    if (!h.saved) return;
    const then = h.count == null ? "" : ` 그때는 ${qty(h.count)}명이었고 지금은 달라질 수 있습니다.`;
    if (!(await confirm({ title: "다시 추출", body: `같은 조건으로 지금 데이터에서 다시 뽑아 엑셀로 내려받습니다.${then} 추출 기록에 새로 남습니다.`, action: "다시 추출", danger: false }))) return;
    await download(h.saved, h.id);
  };
  // 미리보기 칸 — 조건 묶음이 여러 개면 묶음마다의 값('① 3회 · ② 5회'), 그 묶음에 맞지 않았으면 건너뛴다
  const perGroup = (p: Preview, f: (g: { orders: number; amount: number }) => string, one: string) =>
    p.groups && p.groups.length > 1 ? p.groups.map((g, i) => (g ? `${MARK[i] || i + 1} ${f(g)}` : "")).filter(Boolean).join(" · ") : one;
  const card = { channels, products, orderNames, productsError, loadProducts };

  return (
    <div className="b2b-container">
      <div className="b2b-page-head">
        <h1 className="b2b-page-title">오디언스 추출</h1>
      </div>
      {loadError && <div className="b2b-error">{loadError}</div>}

      <div className="sm-tabs aud-mode" role="tablist" aria-label="뽑을 대상">
        <button type="button" role="tab" aria-selected={mode === "buy"} className={`sm-tab ${mode === "buy" ? "is-active" : ""}`} onClick={() => setMode("buy")} disabled={!!busy}>구매 고객</button>
        <button type="button" role="tab" aria-selected={mode === "sub"} className={`sm-tab ${mode === "sub" ? "is-active" : ""}`} onClick={() => setMode("sub")} disabled={!!busy}>정기배송 고객</button>
      </div>

      {mode === "sub" && <SubAudience download={(payload) => download(payload)} onLogged={load} exporting={busy === "export"} canSend={canSend} sends={sends} />}

      {mode === "buy" && (<>
      <section className="b2b-form-section">
        {error && <div className="b2b-error" style={{ marginBottom: "var(--sm-space-4)" }}>{error}</div>}

        {groups.length > 1 && (
          <div className="aud-match">
            <span className="b2b-field-label">조건 묶음 사이</span>
            <div className="sm-tabs" role="group" aria-label="조건 묶음 사이">
              <button type="button" className={`sm-tab ${match === "all" ? "is-active" : ""}`} aria-pressed={match === "all"} onClick={() => setMatch("all")}>그리고 · 모두 맞는 고객</button>
              <button type="button" className={`sm-tab ${match === "any" ? "is-active" : ""}`} aria-pressed={match === "any"} onClick={() => setMatch("any")}>또는 · 하나라도 맞는 고객</button>
            </div>
          </div>
        )}

        {groups.map((g, i) => (
          <div key={i}>
            {i > 0 && <div className="aud-join"><span className="b2b-status-pill aud-join-pill">{match === "any" ? "또는" : "그리고"}</span></div>}
            <GroupCard title={`조건 ${i + 1}`} value={g} onChange={(v) => setGroup(i, v)} onRemove={groups.length > 1 ? () => setGroups((a) => a.filter((_, k) => k !== i)) : undefined} {...card} />
          </div>
        ))}

        {excludes.map((g, i) => (
          <div key={`x${i}`}>
            <div className="aud-join"><span className="b2b-status-pill aud-join-pill">제외</span></div>
            <GroupCard title={`제외 ${i + 1}`} exclude value={g} onChange={(v) => setExclude(i, v)} onRemove={() => setExcludes((a) => a.filter((_, k) => k !== i))} {...card} />
          </div>
        ))}

        <div className="aud-add">
          <button type="button" className="b2b-btn-secondary" onClick={() => setGroups((a) => [...a, EMPTY_G])} disabled={!!busy || groups.length >= MAX_GROUPS}>조건 묶음 추가</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => setExcludes((a) => [...a, EMPTY_G])} disabled={!!busy || excludes.length >= MAX_GROUPS}>제외 조건 추가</button>
        </div>

        <div className="aud-form aud-tail">
          <TallyExclude value={excludeForms} onChange={setExcludeForms} />
          <div className="aud-actions aud-wide">
            <button type="button" className="b2b-btn-primary" onClick={search} disabled={!!busy}>{busy === "search" ? "찾는 중" : "고객 찾기"}</button>
            <button type="button" className="b2b-btn-secondary" onClick={reset} disabled={!!busy || (isBlank && !result)}>조건 지우기</button>
          </div>
        </div>
      </section>

      {result && (
        <section className="b2b-form-section" style={{ marginTop: "var(--sm-space-4)" }}>
          <div className="aud-result-head">
            <span className="aud-count">{qty(result.count)}명</span>
            <span className="aud-count-sub">안심번호(050)·번호 없는 고객 {qty(result.excluded)}명 제외{tallyText(result.tally)}</span>
            <div className="aud-result-actions">
              {canSend && <AlimtalkSend payload={result.payload} count={result.count} summary={result.summary} sends={sends} disabled={!!busy} onSent={load} />}
              <button type="button" className="b2b-btn-secondary" onClick={exportXlsx} disabled={!!busy || result.count === 0}>{busy === "export" ? "만드는 중" : "엑셀 내려받기"}</button>
            </div>
          </div>
          <div className="aud-cond">{result.summary}</div>
          {!!result.tally?.noPhone && <div className="sm-warn" style={{ marginBottom: "var(--sm-space-3)" }}>전화번호를 찾지 못한 탈리 응답 {qty(result.tally.noPhone)}건은 빼지 못했습니다.</div>}
          {result.capped && <div className="sm-warn" style={{ marginBottom: "var(--sm-space-3)" }}>고객이 {qty(result.max)}명을 넘어 앞에서부터 {qty(result.max)}명만 다룹니다. 조건을 좁히세요.</div>}
          {result.count === 0 ? <div className="b2b-empty">조건에 맞는 고객이 없습니다.</div> : (
            <div className="b2b-table-wrap">
              <table className="b2b-table aud-table">
                <thead><tr><th>이름</th><th>전화번호</th><th className="num">주문 횟수</th><th className="num">누적 구매 금액</th><th>첫 구매일</th><th>마지막 구매일</th><th>상품명</th><th>상품코드</th><th>채널</th></tr></thead>
                <tbody>
                  {result.preview.map((p, i) => (
                    <tr key={i}><td>{p.name}</td><td className="sm-nowrap">{p.phone}</td><td className="num sm-nowrap">{perGroup(p, (g) => `${qty(g.orders)}회`, `${qty(p.orders)}회`)}</td><td className="num sm-nowrap">{perGroup(p, (g) => `${won(g.amount)}원`, `${won(p.amount)}원`)}</td><td className="sm-nowrap">{p.first_date}</td><td className="sm-nowrap">{p.last_date}</td><td className="aud-items">{p.items}</td><td className="aud-codes">{p.codes}</td><td>{p.channels}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      </>)}

      {!!sends?.length && <SendHistory sends={sends} canSend={canSend} onChanged={load} />}

      <div className="b2b-card" style={{ marginTop: "var(--sm-space-5)" }}>
        <div className="b2b-card-head"><span className="b2b-card-title">검색·추출 기록</span></div>
        {loading ? <div className="b2b-loading">불러오는 중...</div>
          : history.length === 0 ? <div className="b2b-empty">검색·추출 기록이 없습니다.</div>
          : (
            <div className="b2b-table-wrap">
              <table className="b2b-table aud-history">
                <thead><tr><th>시각</th><th>누가</th><th>한 일</th><th className="num">인원</th><th>조건</th><th></th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td className="sm-nowrap">{dateTime(h.created_at)}</td>
                      <td className="sm-nowrap">{h.actor || "-"}</td>
                      <td><span className="b2b-status-pill" style={h.action === "추출" ? { background: "var(--sm-black)", color: "var(--sm-white)" } : { background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" }}>{h.again ? "다시 추출" : h.action}</span></td>
                      <td className="num">{h.count == null ? "-" : `${qty(h.count)}명`}</td>
                      <td className="aud-cond-cell">{h.cond}</td>
                      <td className="actions sm-nowrap">{h.saved && <button type="button" className="b2b-link-btn" onClick={() => reExport(h)} disabled={!!busy}>다시 추출</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
  );
}
