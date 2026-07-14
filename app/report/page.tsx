"use client";

import { useState } from "react";

type Chart = { type: "bar" | "line" | "pie" | "none"; x?: string; series?: string[]; note?: string };
type Looker = { mode: "query" | "view" | "na"; sql?: string; note?: string };
type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };
type Plan = { understood: string; sql: string; explanation: string; chart: Chart; looker: Looker; caveats: string[]; usage?: Usage };
type Row = Record<string, unknown>;

const EXAMPLES = [
  "이번 달 채널별 매출 상위 10",
  "월별 매출 추세 최근 12개월",
  "대구살(DG) 상품군 재구매율",
  "재고 부족(안전재고 미만) 품목",
  "최근 30일 신규 vs 재구매 고객 수",
  "SKU별 판매수량 top 20 올해",
];

function fmt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(v);
}
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export default function ReportPage() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [cols, setCols] = useState<string[]>([]);
  const [showSql, setShowSql] = useState(false);
  const [copied, setCopied] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);

  async function run(question: string) {
    const qq = question.trim();
    if (!qq || loading) return;
    setLoading(true); setErr(""); setPlan(null); setRows([]); setCols([]); setShowSql(false);
    try {
      const r = await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: qq }) });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "실패"); if (j.plan) setPlan(j.plan); return; }
      setPlan(j.plan); setRows(j.rows || []); setCols(j.columns || []);
    } catch (e) { setErr(e instanceof Error ? e.message : "오류"); }
    finally { setLoading(false); }
  }

  async function exportXlsx() {
    if (!plan) return;
    const r = await fetch("/api/report/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: plan.sql, title: plan.understood }) });
    if (!r.ok) { setErr("엑셀 내보내기 실패"); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `report.xlsx`; a.click(); URL.revokeObjectURL(url);
  }

  function copy(text: string, tag: string) {
    navigator.clipboard?.writeText(text).then(() => { setCopied(tag); setTimeout(() => setCopied(""), 1500); });
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">커스텀 리포트</h1>
          <p className="b2b-page-subtitle">질문을 한국어로 적으면 <strong>매출·재고 데이터를 SQL로 조회</strong>해 표·그래프로 보여주고, <strong>루커스튜디오에 붙일 SQL</strong>까지 만들어줍니다. (읽기전용·개인정보 제외)</p>
        </div>
      </header>

      <div className="rp-ask">
        <textarea className="b2b-input rp-input" rows={2} value={q} placeholder="예: 이번 달 채널별 매출 상위 10개 보여줘"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(q); }} />
        <button className="b2b-btn-primary" onClick={() => run(q)} disabled={loading || !q.trim()}>{loading ? "분석 중…" : "조회 (⌘/Ctrl+Enter)"}</button>
      </div>
      <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {EXAMPLES.map((e) => <button key={e} className="rp-chip" onClick={() => { setQ(e); run(e); }} disabled={loading}>{e}</button>)}
      </div>

      {err && <div className="b2b-error" style={{ marginBottom: 12 }}>{err}</div>}
      {loading && <div className="b2b-loading">질문을 SQL로 바꿔 데이터를 조회하는 중…</div>}

      {plan && (
        <div className="sm-col" style={{ gap: 14 }}>
          <div className="rp-understood">💡 {plan.understood}</div>
          {plan.usage && (
            <div className="sm-faint" style={{ fontSize: 11, marginTop: -8 }}>
              토큰 · 입력 {(plan.usage.input + plan.usage.cacheRead + plan.usage.cacheWrite).toLocaleString()}
              {plan.usage.cacheRead > 0 ? ` (캐시적중 ${plan.usage.cacheRead.toLocaleString()})` : plan.usage.cacheWrite > 0 ? ` (캐시저장 ${plan.usage.cacheWrite.toLocaleString()})` : ""}
              {" · 출력 "}{plan.usage.output.toLocaleString()}
            </div>
          )}

          {!err && rows.length > 0 && plan.chart?.type && plan.chart.type !== "none" && plan.chart.x && plan.chart.series?.length ? (
            <section className="b2b-card"><MiniChart chart={plan.chart} rows={rows} /></section>
          ) : null}

          {!err && (
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">결과 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 12 }}>{rows.length}행{rows.length >= 5000 ? " (5,000행 제한)" : ""}</span></span>
                <button className="b2b-btn-secondary" style={{ padding: "4px 10px" }} onClick={exportXlsx} disabled={!rows.length}>엑셀 내보내기</button>
              </div>
              {rows.length === 0 ? <div className="b2b-empty">결과가 없습니다.</div> : (
                <div className="b2b-table-wrap" style={{ maxHeight: 480, overflow: "auto" }}>
                  <table className="b2b-table" style={{ fontSize: 12.5 }}>
                    <thead><tr>{cols.map((c) => <th key={c} className={typeof rows[0][c] === "number" ? "num" : ""}>{c}</th>)}</tr></thead>
                    <tbody>
                      {rows.slice(0, 500).map((r, i) => (
                        <tr key={i}>{cols.map((c) => <td key={c} className={typeof r[c] === "number" ? "num b2b-money" : ""}>{fmt(r[c])}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length > 500 && <div className="sm-faint" style={{ fontSize: 11, padding: 6 }}>표는 500행까지 표시 · 전체는 엑셀로 내보내기</div>}
                </div>
              )}
              {plan.explanation && <p className="sm-faint" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>· {plan.explanation}</p>}
              {plan.caveats?.length > 0 && <ul className="rp-caveats">{plan.caveats.map((c, i) => <li key={i}>⚠ {c}</li>)}</ul>}
            </section>
          )}

          {/* 루커스튜디오용 SQL */}
          {plan.looker && plan.looker.mode !== "na" && plan.looker.sql && (
            <section className="b2b-card">
              <div className="b2b-card-head">
                <span className="b2b-card-title">📊 루커스튜디오용 SQL <span className="sm-faint" style={{ fontWeight: 400, fontSize: 12 }}>{plan.looker.mode === "view" ? "· 뷰 생성(SQL Editor에 적용 후 사용)" : "· 커스텀 쿼리로 붙여넣기"}</span></span>
                <button className="b2b-btn-secondary" style={{ padding: "4px 10px" }} onClick={() => copy(plan.looker.sql || "", "looker")}>{copied === "looker" ? "복사됨 ✓" : "복사"}</button>
              </div>
              {plan.looker.note && <p className="sm-faint" style={{ fontSize: 12, marginBottom: 8 }}>{plan.looker.note}</p>}
              <pre className="rp-sql">{plan.looker.sql}</pre>
            </section>
          )}

          {/* 생성된 조회 SQL(투명성) */}
          <div>
            <button className="b2b-link-btn" style={{ fontSize: 12 }} onClick={() => setShowSql((v) => !v)}>{showSql ? "▾ 생성된 조회 SQL 숨기기" : "▸ 생성된 조회 SQL 보기"}</button>
            {showSql && (
              <div className="sm-col" style={{ gap: 4, marginTop: 6 }}>
                <div className="sm-row" style={{ justifyContent: "flex-end" }}><button className="b2b-link-btn" style={{ fontSize: 11 }} onClick={() => copy(plan.sql, "sql")}>{copied === "sql" ? "복사됨 ✓" : "SQL 복사"}</button></div>
                <pre className="rp-sql">{plan.sql}</pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 루커스튜디오 적용 가이드 (하단 상시 참고) */}
      <section className="rp-guide">
        <button className="rp-guide-head" onClick={() => setGuideOpen((v) => !v)}>
          <span>📖 루커스튜디오(데이터 스튜디오)에 적용하는 법</span>
          <span className="rp-guide-chev">{guideOpen ? "▾" : "▸"}</span>
        </button>
        {guideOpen && (
          <div className="rp-guide-body">
            <p className="rp-guide-lead">위 <b>「📊 루커스튜디오용 SQL」</b>은 두 종류로 나와요. 카드에 <b>커스텀 쿼리</b>라고 적혀 있으면 A, <b>뷰 생성</b>이면 B를 따르세요.</p>

            <div className="rp-guide-block">
              <div className="rp-guide-title">A. 커스텀 쿼리 <span className="rp-guide-tag ok">Supabase 작업 불필요</span></div>
              <ol className="rp-guide-steps">
                <li>루커스튜디오 보고서 → <b>데이터 추가</b> → <b>PostgreSQL</b> 커넥터 (이미 연결돼 있으면 그 데이터소스 선택)</li>
                <li>접속정보 입력 후 <b>맞춤 쿼리(CUSTOM QUERY)</b> 선택</li>
                <li>복사한 <b>SELECT</b> 문을 붙여넣기 → <b>추가</b></li>
                <li>차트에 필드를 연결하면 끝</li>
              </ol>
            </div>

            <div className="rp-guide-block">
              <div className="rp-guide-title">B. 뷰 생성 <span className="rp-guide-tag warn">Supabase에 1회 적용 필요</span></div>
              <ol className="rp-guide-steps">
                <li>복사한 <code>create view … ; grant … to looker_ro;</code> 를 <b>Supabase 대시보드 → SQL Editor</b> 에 붙여넣고 <b>Run</b></li>
                <li>루커스튜디오 → <b>데이터 추가</b> → 아래 접속정보 → <b>테이블 목록에서 새 뷰 선택</b><br /><span className="sm-faint">(이미 데이터소스가 있으면: 데이터소스 편집 → 우측 상단 <b>필드 새로고침</b>)</span></li>
                <li>차트에 연결</li>
              </ol>
              <p className="rp-guide-note">루커는 읽기전용 <code>looker_ro</code> 계정이라 <b>뷰를 스스로 못 만들어요.</b> 그래서 새 데이터가 필요하면 이렇게 한 번만 Supabase에 만들어줘야 합니다.</p>
            </div>

            <div className="rp-guide-block">
              <div className="rp-guide-title">PostgreSQL 접속정보 (커넥터 최초 연결 시)</div>
              <table className="rp-guide-conn">
                <tbody>
                  <tr><td>호스트</td><td><code>aws-1-ap-northeast-2.pooler.supabase.com</code></td></tr>
                  <tr><td>포트</td><td><code>5432</code></td></tr>
                  <tr><td>데이터베이스</td><td><code>postgres</code></td></tr>
                  <tr><td>사용자</td><td><code>looker_ro.uwbkejkztuhzcesrffzq</code> <span className="sm-faint">(반드시 role.projectref)</span></td></tr>
                  <tr><td>비밀번호</td><td>설정하신 looker_ro 비밀번호</td></tr>
                  <tr><td>SSL</td><td>사용 (Enable SSL)</td></tr>
                </tbody>
              </table>
              <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 6 }}>* 이미 매출 대시보드를 만들며 연결해둔 그 데이터소스와 <b>같은 접속정보</b>입니다. 새로 연결할 때만 필요해요.</p>
            </div>

            <div className="rp-guide-block">
              <div className="rp-guide-title">자주 겪는 것</div>
              <ul className="rp-guide-tips">
                <li><b>날짜가 안 맞아요</b> → 보고서/데이터소스 타임존을 <b>(GMT+9) 서울</b>로 설정</li>
                <li><b>바뀐 데이터가 안 보여요</b> → 데이터소스 <b>새로고침</b> (기본 캐시 12시간)</li>
                <li><b>새 컬럼/뷰가 안 떠요</b> → 데이터소스 편집에서 <b>필드 새로고침</b></li>
                <li><b>팀원도 보게 하려면</b> → 데이터소스를 <b>소유자 자격증명</b>으로 공유</li>
              </ul>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// 간단 차트 — x축 라벨 + 첫 series 값. bar/pie=가로막대, line=세로 추세.
function MiniChart({ chart, rows }: { chart: Chart; rows: Row[] }) {
  const x = chart.x!;
  const s = chart.series![0];
  const data = rows.slice(0, 40).map((r) => ({ label: fmt(r[x]), value: num(r[s]) }));
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const title = `${s} — ${x}`;
  if (chart.type === "line") {
    const W = 640, H = 200, pad = 28;
    const step = data.length > 1 ? (W - pad * 2) / (data.length - 1) : 0;
    const pts = data.map((d, i) => [pad + i * step, H - pad - (Math.abs(d.value) / max) * (H - pad * 2)]);
    const path = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    return (
      <div>
        <div className="sm-faint" style={{ fontSize: 12, marginBottom: 8 }}>{title}</div>
        <div style={{ overflowX: "auto" }}>
          <svg width={W} height={H} style={{ maxWidth: "100%" }}>
            <path d={path} fill="none" stroke="var(--sm-info)" strokeWidth={2} />
            {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={2.5} fill="var(--sm-info)" />)}
          </svg>
        </div>
        <div className="sm-row" style={{ justifyContent: "space-between", fontSize: 10, color: "var(--sm-faint,#999)" }}><span>{data[0]?.label}</span><span>{data[data.length - 1]?.label}</span></div>
      </div>
    );
  }
  // bar / pie → 가로 막대
  return (
    <div>
      <div className="sm-faint" style={{ fontSize: 12, marginBottom: 10 }}>{title}</div>
      <div className="sm-col" style={{ gap: 7 }}>
        {data.map((d, i) => (
          <div key={i} className="sm-row" style={{ gap: 10, alignItems: "center" }}>
            <div style={{ width: 130, fontSize: 12, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={d.label}>{d.label}</div>
            <div style={{ flex: 1, background: "var(--sm-bg-subtle)", borderRadius: 5, height: 20, position: "relative" }}>
              <div style={{ width: `${Math.max(2, (Math.abs(d.value) / max) * 100)}%`, height: "100%", background: "var(--sm-info)", borderRadius: 5 }} />
            </div>
            <div style={{ width: 90, fontSize: 12, fontWeight: 600, textAlign: "right" }}>{d.value.toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
