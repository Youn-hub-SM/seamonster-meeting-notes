"use client";

// 파도소리 예상 — 출고·창고 생산·매입 전체 전망 + 창고 가공품별 생산 권장 + 주문 생산 부하. 관리자만.
//  데이터는 ERP 엑셀 두 개를 [데이터 올리기]로 넣는다(브라우저가 읽어 합친 결과만 저장 — app/lib/factory-flow.ts).
//  계산은 app/lib/factory-forecast.ts. 기획 docs/factory-forecast-plan.md, 근거 docs/factory-shipment-analysis.md.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { StackedBar, LineChart, ChartLegend, PIE_COLORS } from "@/app/components/charts";
import { readSourceFile, buildFlows, rangeProblem, FLOW_KINDS, FLOW_LABEL, type FlowTuple, type FlowSummary, type SrcFile } from "@/app/lib/factory-flow";
import {
  computeForecast, DAY_CHOICES, DEFAULT_FORECAST_SETTINGS, SERIES_LABEL,
  type FlowOverview, type FlowItemDetail, type ForecastSettings, type ItemRow, type SeriesKey, type CheckRow, type SeriesForecast,
} from "@/app/lib/factory-forecast";

const kg = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}kg`;
const ton = (n: number) => `${(Math.round(n / 100) / 10).toLocaleString("ko-KR")}톤`;
const ymLabel = (ym: string) => `${ym.slice(2, 4)}.${ym.slice(5, 7)}`;
const monthName = (ym: string) => `${Number(ym.slice(5, 7))}월`;
const firm = (s: string) => s.split("/")[0].trim() || s;
const diffPct = (r: CheckRow) => (r.actual > 0 ? `${r.forecast >= r.actual ? "+" : "−"}${Math.abs(Math.round((r.forecast / r.actual - 1) * 100))}%` : "-");
const SERIES: SeriesKey[] = ["ship", "prod", "buy"];
const BAR_COLORS = ["var(--sm-orange)", "var(--sm-orange-border)"];
const CHUNK = 5000;

function usageLabel(r: ItemRow): string {
  const p = Math.round(r.floorShare * 100);
  return `${p >= 80 ? "반제품" : p <= 25 ? "완제품" : "둘 다"} · 현장 ${p}%`;
}

type Upload =
  | { step: "read"; ratio: number }
  | { step: "ready"; rows: FlowTuple[]; summary: FlowSummary }
  | { step: "send"; ratio: number }
  | { step: "error"; message: string };

export default function FactoryForecastPage() {
  const [overview, setOverview] = useState<FlowOverview | null>(null);
  const [stock, setStock] = useState<Record<string, number>>({});
  const [settings, setSettings] = useState<ForecastSettings>(DEFAULT_FORECAST_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [warn, setWarn] = useState("");
  const [tab, setTab] = useState<SeriesKey>("ship");
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, FlowItemDetail | "loading" | "error">>({});
  const [upload, setUpload] = useState<Upload | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/factory/forecast", { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setOverview(j.overview); setStock(j.stock || {}); setSettings(j.settings || DEFAULT_FORECAST_SETTINGS);
      setWarn(j.stockError ? `현재고를 읽지 못했습니다 — ${j.stockError}` : "");
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const fc = useMemo(() => (overview ? computeForecast(overview, stock, settings) : null), [overview, stock, settings]);

  async function saveSettings(body: Record<string, unknown>) {
    setError("");
    try {
      const res = await fetch("/api/factory/forecast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || "저장 실패");
      setSettings(j.settings);
    } catch (e) { setError(e instanceof Error ? e.message : "저장 오류"); }
  }

  async function toggle(item: string) {
    if (open === item) { setOpen(null); return; }
    setOpen(item);
    if (details[item] && details[item] !== "error") return;
    setDetails((d) => ({ ...d, [item]: "loading" }));
    try {
      const j = await (await fetch(`/api/factory/forecast/item?item=${encodeURIComponent(item)}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error);
      setDetails((d) => ({ ...d, [item]: j.detail as FlowItemDetail }));
    } catch { setDetails((d) => ({ ...d, [item]: "error" })); }
  }

  // 엑셀 두 개 읽기 → 흐름으로 나누기 → 미리보기
  async function pickFiles(files: File[]) {
    setNotice("");
    if (files.length !== 2) { setUpload({ step: "error", message: "출고 파일과 매입생산 파일 두 개를 함께 고르세요." }); return; }
    setUpload({ step: "read", ratio: 0 });
    try {
      const src: SrcFile[] = [];
      for (let i = 0; i < 2; i++) src.push(await readSourceFile(files[i], (r) => setUpload({ step: "read", ratio: (i + r) / 2 })));
      const ship = src.find((s) => s.type === "ship"), prod = src.find((s) => s.type === "prod");
      if (!ship || !prod) throw new Error("출고 파일 하나와 매입생산 파일 하나를 고르세요. 같은 종류가 두 개입니다.");
      const problem = rangeProblem(ship, prod);
      if (problem) throw new Error(problem);
      setUpload({ step: "ready", ...buildFlows(ship, prod) });
    } catch (e) { setUpload({ step: "error", message: e instanceof Error ? e.message : "파일을 읽지 못했습니다." }); }
  }

  async function send(rows: FlowTuple[], summary: FlowSummary) {
    const batch = crypto.randomUUID();
    const post = async (body: Record<string, unknown>) => {
      const res = await fetch("/api/factory/forecast/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || "올리기 실패");
    };
    try {
      for (let at = 0; at < rows.length; at += CHUNK) {
        setUpload({ step: "send", ratio: at / rows.length });
        await post({ batch, rows: rows.slice(at, at + CHUNK) });
      }
      setUpload({ step: "send", ratio: 1 });
      await post({ batch, commit: true, from: summary.from, to: summary.to });
      setUpload(null);
      setNotice(`${summary.from} ~ ${summary.to} 데이터를 올렸습니다.`);
      setDetails({}); setOpen(null);
      await load();
    } catch (e) { setUpload({ step: "error", message: e instanceof Error ? e.message : "올리기 실패" }); }
  }

  const uploadBtn = (primary: boolean) => (
    <label className={`${primary ? "b2b-btn-primary" : "b2b-btn-secondary"} fac-upload`}>
      데이터 올리기
      <input type="file" accept=".xlsx" multiple hidden
        onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ""; if (f.length) pickFiles(f); }} />
    </label>
  );

  const shown = fc ? fc.items.filter((r) => showAll || r.make == null || r.make > 0) : [];
  const hidden = fc ? fc.items.length - shown.length : 0;
  const makeSum = fc ? fc.items.reduce((s, r) => s + (r.make || 0), 0) : 0;
  const makeCount = fc ? fc.items.filter((r) => (r.make || 0) > 0).length : 0;

  return (
    <div className="b2b-container fac-fc">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">예상</h1>
          {fc && <p className="b2b-page-subtitle">{fc.lastDate} 까지의 데이터</p>}
        </div>
        <div className="b2b-page-actions">{uploadBtn(false)}</div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {notice && <div className="sm-success">{notice}</div>}
      {warn && <div className="sm-warn">{warn}</div>}

      {loading ? <div className="b2b-loading">불러오는 중...</div> : !fc ? (
        !error && <div className="b2b-empty">올린 데이터가 없습니다.</div>
      ) : (
        <>
          <div className="b2b-dash-grid fac-cards">
            {SERIES.map((k) => {
              const s = fc.series[k], n = s.next[0];
              return (
                <div className="b2b-stat-card" key={k}>
                  <div className="b2b-stat-card-label">{monthName(n.ym)} {SERIES_LABEL[k]} 예상</div>
                  <div className="b2b-stat-card-value">{kg(n.kg)}</div>
                  <div className="b2b-stat-card-hint">
                    지금까지 {kg(fc.thisMonthSoFar[k])}{s.lastYear[0] != null ? ` · 전년 ${kg(s.lastYear[0])}` : ""}
                  </div>
                </div>
              );
            })}
            <div className="b2b-stat-card">
              <div className="b2b-stat-card-label">생산 권장 합계</div>
              <div className="b2b-stat-card-value">{kg(makeSum)}</div>
              <div className="b2b-stat-card-hint">{makeCount}개 품목 · {settings.days}일 기준</div>
            </div>
          </div>

          <section className="b2b-card fac-fc-sec">
            <div className="b2b-card-head">
              <span className="b2b-card-title">월별 추이</span>
              <div className="sm-tabs">
                {SERIES.map((k) => (
                  <button key={k} type="button" className={`sm-tab ${tab === k ? "is-active" : ""}`} onClick={() => setTab(k)}>{SERIES_LABEL[k]}</button>
                ))}
              </div>
            </div>
            <TrendBlock s={fc.series[tab]} />
          </section>

          <section className="b2b-card fac-fc-sec">
            <div className="b2b-card-head">
              <span className="b2b-card-title">창고 품목</span>
              <div className="sm-tabs">
                {DAY_CHOICES.map((d) => (
                  <button key={d} type="button" className={`sm-tab ${settings.days === d ? "is-active" : ""}`} onClick={() => saveSettings({ days: d })}>{d}일</button>
                ))}
              </div>
            </div>
            <p className="fac-fc-rule">창고에서 빠진 양(현장 + 거래처) 최근 52주 기준 · 생산 권장 = 많을 때 − 현재고</p>
            {fc.unlinked > 0 && <div className="sm-warn">현재고를 잇지 못한 품목 {fc.unlinked}개 — 상품마스터의 품목 이름이 다릅니다.</div>}
            <div className="b2b-table-wrap">
              <table className="b2b-table fac-fc-table">
                <thead><tr>
                  <th>품목</th><th>쓰임</th><th className="num">현재고</th>
                  <th className="num">{settings.days}일 보통</th><th className="num">{settings.days}일 많을 때</th>
                  <th className="num">생산 권장</th><th>최근 생산</th><th>몰림</th>
                </tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <Fragment key={r.item}>
                      <tr className={`fac-fc-row ${open === r.item ? "is-open" : ""}`} onClick={() => toggle(r.item)}>
                        <td><strong>{r.item}</strong></td>
                        <td className="sm-nowrap">{usageLabel(r)}</td>
                        <td className="num fac-num">{r.stock == null ? "-" : kg(r.stock)}</td>
                        <td className="num fac-num">{kg(r.usual)}</td>
                        <td className="num fac-num">{kg(r.high)}</td>
                        <td className="num fac-num">{r.make == null ? "-" : r.make > 0 ? <strong>{kg(r.make)}</strong> : "0"}</td>
                        <td className="sm-nowrap">{r.lastProd || "-"}</td>
                        <td>{r.crowd ? `${firm(r.crowd.partner)} ${Math.round(r.crowd.share * 100)}%` : ""}</td>
                      </tr>
                      {open === r.item && (
                        <tr className="fac-fc-detail"><td colSpan={8}>
                          <ItemDetail row={r} detail={details[r.item]} onExclude={() => { setOpen(null); saveSettings({ exclude: r.item }); }} />
                        </td></tr>
                      )}
                    </Fragment>
                  ))}
                  {shown.length === 0 && <tr><td colSpan={8} className="sm-faint">생산 권장이 있는 품목이 없습니다.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="fac-fc-foot">
              {hidden > 0 || showAll ? (
                <button type="button" className="b2b-link-btn" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? "권장 있는 품목만 보기" : `권장 없는 품목 ${hidden}개 보기`}
                </button>
              ) : <span />}
              <span className="sm-faint">그 밖 가공품 {fc.restCount}개 · 최근 12개월 {kg(fc.restOut12)}</span>
            </div>
            {settings.excluded.length > 0 && (
              <div className="fac-fc-excluded">
                <span className="sm-faint">표에서 뺀 품목</span>
                {settings.excluded.map((it) => (
                  <button key={it} type="button" className="b2b-link-btn" onClick={() => saveSettings({ include: it })}>{it} 되돌리기</button>
                ))}
              </div>
            )}
          </section>

          <section className="b2b-card fac-fc-sec">
            <div className="b2b-card-head"><span className="b2b-card-title">주문 생산 부하</span></div>
            <p className="fac-fc-rule">주문 받은 날 만들어 나간 양 · 최근 8주</p>
            <div className="b2b-table-wrap">
              <table className="b2b-table fac-fc-table">
                <thead><tr><th></th>{fc.orderLoad.map((d) => <th key={d.day} className="num">{d.day}</th>)}</tr></thead>
                <tbody>
                  <tr><td>평균</td>{fc.orderLoad.map((d) => <td key={d.day} className="num fac-num">{kg(d.avg)}</td>)}</tr>
                  <tr><td>가장 많은 날</td>{fc.orderLoad.map((d) => <td key={d.day} className="num fac-num">{kg(d.peak)}</td>)}</tr>
                </tbody>
              </table>
            </div>
          </section>

          {fc.check.totals.length > 0 && (
            <section className="b2b-card fac-fc-sec">
              <div className="b2b-card-head"><span className="b2b-card-title">지난 예상 확인</span></div>
              <p className="fac-fc-rule">
                {monthName(fc.check.ym)}을 그 전달까지의 데이터로 예상했을 때
                {fc.check.itemError != null ? ` · 품목별 오차 ${Math.round(fc.check.itemError * 100)}%` : ""}
              </p>
              <div className="fx-2col">
                <CheckTable head="전체" rows={fc.check.totals} />
                <CheckTable head="품목(창고에서 빠진 양)" rows={fc.check.items.slice(0, 10)} />
              </div>
            </section>
          )}

          <section className="b2b-card fac-fc-sec">
            <div className="b2b-card-head"><span className="b2b-card-title">뺀 거래</span></div>
            <p className="fac-fc-rule">한 줄 3,000kg 이상 출고와 수산물잔재물은 출고 예상에서 뺀다 · 수산물잔재물 최근 1년 {kg(fc.wasteKg)}</p>
            {fc.excluded.length === 0 ? <div className="b2b-empty">뺀 대량 출고가 없습니다.</div> : (
              <div className="b2b-table-wrap">
                <table className="b2b-table fac-fc-table">
                  <thead><tr><th>날짜</th><th>품목</th><th>거래처</th><th className="num">kg</th></tr></thead>
                  <tbody>
                    {fc.excluded.slice(0, 30).map((r, i) => (
                      <tr key={i}><td className="sm-nowrap">{r.date}</td><td>{r.item}</td><td>{firm(r.partner)}</td><td className="num fac-num">{kg(r.kg)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {upload && (
        <div className="b2b-modal-backdrop" onClick={() => { if (upload.step === "ready" || upload.step === "error") setUpload(null); }}>
          <div className="b2b-modal fac-fc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="b2b-modal-head"><span className="b2b-modal-title">데이터 올리기</span></div>
            <div className="b2b-modal-body">
              {upload.step === "read" && <Progress label="파일을 읽는 중" ratio={upload.ratio} />}
              {upload.step === "send" && <Progress label="올리는 중" ratio={upload.ratio} />}
              {upload.step === "error" && <div className="b2b-error">{upload.message}</div>}
              {upload.step === "ready" && (
                <table className="b2b-table fac-fc-table">
                  <tbody>
                    <tr><td>기간</td><td className="num">{upload.summary.from} ~ {upload.summary.to}</td></tr>
                    <tr><td>원본 행</td><td className="num fac-num">{upload.summary.srcRows.toLocaleString("ko-KR")}</td></tr>
                    <tr><td>품명</td><td className="num fac-num">{upload.summary.items.toLocaleString("ko-KR")}개</td></tr>
                    {FLOW_KINDS.map((k) => (
                      <tr key={k}><td>{FLOW_LABEL[k]}</td><td className="num fac-num">{kg(upload.summary.kg[k])}</td></tr>
                    ))}
                    <tr><td>뺀 대량 거래</td><td className="num fac-num">{upload.summary.big.toLocaleString("ko-KR")}건 · {kg(upload.summary.bigKg)}</td></tr>
                    <tr><td>수산물잔재물</td><td className="num fac-num">{kg(upload.summary.wasteKg)}</td></tr>
                    <tr><td>중량을 다시 계산한 행</td><td className="num fac-num">{upload.summary.changed.toLocaleString("ko-KR")}</td></tr>
                  </tbody>
                </table>
              )}
              {upload.step === "ready" && <p className="fac-fc-rule">이 기간에 이미 올린 데이터는 지우고 새로 넣는다</p>}
            </div>
            <div className="b2b-modal-foot">
              <button className="b2b-btn-secondary" disabled={upload.step === "read" || upload.step === "send"} onClick={() => setUpload(null)}>닫기</button>
              {upload.step === "ready" && <button className="b2b-btn-primary" onClick={() => send(upload.rows, upload.summary)}>올리기</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Progress({ label, ratio }: { label: string; ratio: number }) {
  return (
    <div className="fac-fc-progress">
      <div>{label} {Math.round(ratio * 100)}%</div>
      <div className="fac-fc-bar"><span style={{ width: `${Math.round(ratio * 100)}%` }} /></div>
    </div>
  );
}

function TrendBlock({ s }: { s: SeriesForecast }) {
  const periods = [...s.history.map((h) => ymLabel(h.ym)), ...s.next.map((n) => ymLabel(n.ym))];
  const actual = [...s.history.map((h) => h.kg), ...s.next.map(() => 0)];
  const forecast = [...s.history.map(() => 0), ...s.next.map((n) => n.kg)];
  return (
    <>
      <ChartLegend items={[["실적", BAR_COLORS[0]], ["예상", BAR_COLORS[1]]]} />
      <StackedBar periods={periods} series={[{ key: "실적", values: actual }, { key: "예상", values: forecast }]} colors={BAR_COLORS} fmtAxis={ton} unit="kg" />
      <div className="b2b-table-wrap">
        <table className="b2b-table fac-fc-table">
          <thead><tr><th></th>{s.next.map((n) => <th key={n.ym} className="num">{n.ym}</th>)}</tr></thead>
          <tbody>
            <tr><td>예상</td>{s.next.map((n) => <td key={n.ym} className="num fac-num">{kg(n.kg)}</td>)}</tr>
            <tr><td>전년 같은 달</td>{s.lastYear.map((v, i) => <td key={i} className="num fac-num">{v == null ? "-" : kg(v)}</td>)}</tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function CheckTable({ head, rows }: { head: string; rows: CheckRow[] }) {
  return (
    <div className="b2b-table-wrap">
      <table className="b2b-table fac-fc-table">
        <thead><tr><th>{head}</th><th className="num">예상</th><th className="num">실제</th><th className="num">차이</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}><td>{r.label}</td><td className="num fac-num">{kg(r.forecast)}</td><td className="num fac-num">{kg(r.actual)}</td><td className="num fac-num">{diffPct(r)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ItemDetail({ row, detail, onExclude }: { row: ItemRow; detail: FlowItemDetail | "loading" | "error" | undefined; onExclude: () => void }) {
  if (!detail || detail === "loading") return <div className="b2b-loading">불러오는 중...</div>;
  if (detail === "error") return <div className="b2b-error">품목 기록을 불러오지 못했습니다.</div>;
  const m = detail.monthly;
  const colors = [PIE_COLORS[1], PIE_COLORS[2], PIE_COLORS[3]];
  const shipTotal = detail.partners.reduce((s, p) => s + p[1], 0);
  return (
    <div className="fac-fc-detail-in">
      <ChartLegend items={[["창고 생산", colors[0]], ["현장으로", colors[1]], ["거래처로", colors[2]]]} />
      <LineChart
        periods={m.map((r) => ymLabel(r[0]))}
        series={[
          { key: "창고 생산", values: m.map((r) => r[1]), color: colors[0] },
          { key: "현장으로", values: m.map((r) => r[2]), color: colors[1] },
          { key: "거래처로", values: m.map((r) => r[3]), color: colors[2] },
        ]}
        fmtAxis={ton} unit="kg" height={200}
      />
      <div className="fac-fc-detail-meta">
        <span>최근 12개월 창고 생산 {kg(row.prod12)} · 빠진 양 {kg(row.out12)}</span>
        {detail.partners.length > 0 && (
          <span>거래처 {detail.partners.map((p) => `${firm(p[0])} ${shipTotal > 0 ? Math.round((p[1] / shipTotal) * 100) : 0}%`).join(" · ")}</span>
        )}
        <button type="button" className="b2b-link-btn" onClick={onExclude}>표에서 빼기</button>
      </div>
    </div>
  );
}
