"use client";

import { useState } from "react";

// 내부도구 공용 차트 프리미티브 — 도넛 / 세로막대 추세 / 분포 도넛카드 / 가로바 리스트.
// 디자인시스템: 카테고리 구분 색은 토큰이 아닌 전용 팔레트(PIE_COLORS) 예외. 레이아웃은 .b2b-card / .sm-* 사용.

// 카테고리 구분용 팔레트(차트 전용)
export const PIE_COLORS = ["#F15A30", "#1971C2", "#22863A", "#B08800", "#C92A2A", "#7C3AED", "#0EA5A4", "#E8590C", "#6B7280", "#DB2777"];
// 콤보차트 선 기본색 — 막대(브랜드·시맨틱)와 구분되는 보라. PIE_COLORS 와 같은 값이지만
// 순환 인덱스가 아니라 고정 역할색이므로 별도 상수로 둔다.
export const CHART_LINE = PIE_COLORS[5];

// 세로막대 3종(TrendChart/StackedBar/ComboBarLine)이 공유하는 좌표계.
// 나란히 놓였을 때 같은 차트로 보이도록 높이·여백·막대 모양을 한 곳에서 정한다.
const GEOM = { W: 760, H: 240, padL: 44, padT: 12, padB: 28, rx: 4, barMax: 46, barRatio: 0.55 };
const AXIS_FS = { y: 10.5, x: 11 };
// X축 라벨 솎음 — 슬롯이 좁으면 겹치므로 일정 간격만 그린다.
const labelStep = (n: number) => Math.ceil(n / 14);
const showLabel = (i: number, n: number) => n <= 14 || i % labelStep(n) === 0;

// 차트 범례 — .sm-chart-legend(b2b.css). 화면마다 인라인으로 재구현하지 말 것.
export function ChartLegend({ items, style }: { items: [string, string][]; style?: React.CSSProperties }) {
  return (
    <div className="sm-chart-legend" style={style}>
      {items.map(([label, color]) => (
        <span key={label}><i style={{ background: color }} />{label}</span>
      ))}
    </div>
  );
}

// 축 눈금용 — 보기 좋은 상한값(1/2/5 ×10ⁿ)
export function niceCeil(n: number): number {
  if (n <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(n)));
  const r = n / p;
  const m = r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10;
  return m * p;
}

// 금액 축약(억/만) — 차트 축 라벨용
export function moneyCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(a % 1e8 === 0 ? 0 : 1)}억`;
  if (a >= 1e4) return `${Math.round(n / 1e4).toLocaleString()}만`;
  return n.toLocaleString();
}

// 도넛(중앙 총계). colors 미지정 시 PIE_COLORS 순환.
export function Donut({ data, colors, size = 132, center, centerSub }: { data: [string, number][]; colors?: string[]; size?: number; center: string; centerSub?: string }) {
  const total = data.reduce((s, [, n]) => s + n, 0);
  const R = 42, W = 18, cx = 60, cy = 60, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} style={{ flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--sm-bg-subtle)" strokeWidth={W} />
      {total > 0 && data.map(([label, n], i) => {
        if (n <= 0) return null;
        const len = (n / total) * C;
        const seg = (
          <circle key={i} cx={cx} cy={cy} r={R} fill="none" stroke={colors ? colors[i] : PIE_COLORS[i % PIE_COLORS.length]}
            strokeWidth={W} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off}
            transform={`rotate(-90 ${cx} ${cy})`}><title>{`${label} ${Math.round((n / total) * 100)}%`}</title></circle>
        );
        off += len;
        return seg;
      })}
      <text x={cx} y={cy - 1} textAnchor="middle" fontSize="20" fontWeight="800" fill="var(--sm-black)">{center}</text>
      {centerSub && <text x={cx} y={cy + 15} textAnchor="middle" fontSize="11" fill="var(--sm-text-light)">{centerSub}</text>}
    </svg>
  );
}

// 세로 막대 추세 — 가로 그리드선 + Y축 눈금 + X축 라벨. tip 은 막대 호버 텍스트.
//  accent 미지정 시 브랜드 주황. 의미축(입고=success/출고=info 등)이 있는 데이터는
//  반드시 그 색을 넘길 것 — 안 그러면 같은 화면의 표·배지와 색이 어긋난다.
export function TrendChart({ data, fmtAxis, accent }: { data: { label: string; value: number; tip?: string }[]; fmtAxis?: (n: number) => string; accent?: string }) {
  if (!data.length) return <div className="sm-faint" style={{ fontSize: 13, padding: "8px 2px" }}>데이터 없음</div>;
  const fmt = fmtAxis || ((n: number) => n.toLocaleString());
  const top = niceCeil(Math.max(...data.map((d) => d.value), 1));
  const { W, H, padL, padT, padB, rx, barMax, barRatio } = GEOM, padR = 10;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / data.length, bw = Math.min(barMax, slot * barRatio);
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => top * f);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--sm-border-light)" strokeWidth="1" />
          <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" fontSize={AXIS_FS.y} fill="var(--sm-text-light)">{fmt(Math.round(t))}</text>
        </g>
      ))}
      {data.map((d, i) => {
        const cx = padL + slot * i + slot / 2;
        const yy = y(d.value);
        return (
          <g key={i}>
            <rect x={cx - bw / 2} y={yy} width={bw} height={Math.max(0, padT + plotH - yy)} rx={rx} fill={accent || "var(--sm-orange)"}>
              <title>{d.tip || `${d.label} · ${fmt(d.value)}`}</title>
            </rect>
            {showLabel(i, data.length) && <text x={cx} y={H - 9} textAnchor="middle" fontSize={AXIS_FS.x} fill="var(--sm-text-mid)">{d.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// 누적 세로막대 — 기간(X축) × 카테고리(누적 세그먼트). 유형별 시계열 변화용.
//  series[i].values 는 periods 와 같은 길이. 세그먼트 호버 시 "기간 · 유형 N건".
export function StackedBar({ periods, series, colors, fmtAxis, unit = "건" }: {
  periods: string[];
  series: { key: string; values: number[] }[];
  colors?: string[];
  fmtAxis?: (n: number) => string;
  unit?: string; // 세그먼트 툴팁 값 단위(건/원 등)
}) {
  if (!periods.length || !series.length) return <div className="sm-faint" style={{ fontSize: 13, padding: "8px 2px" }}>데이터 없음</div>;
  const fmt = fmtAxis || ((n: number) => n.toLocaleString());
  const totals = periods.map((_, i) => series.reduce((s, ser) => s + (ser.values[i] || 0), 0));
  const top = niceCeil(Math.max(...totals, 1));
  const { W, H, padL, padT, padB, rx, barMax, barRatio } = GEOM, padR = 10;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / periods.length, bw = Math.min(barMax, slot * barRatio);
  const hOf = (v: number) => (v / top) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => top * f);
  const col = (i: number) => (colors ? colors[i % colors.length] : PIE_COLORS[i % PIE_COLORS.length]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
      {ticks.map((t, i) => {
        const yy = padT + plotH - hOf(t);
        return (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={yy} y2={yy} stroke="var(--sm-border-light)" strokeWidth="1" />
            <text x={padL - 6} y={yy + 3.5} textAnchor="end" fontSize={AXIS_FS.y} fill="var(--sm-text-light)">{fmt(Math.round(t))}</text>
          </g>
        );
      })}
      {periods.map((p, i) => {
        const cx = padL + slot * i + slot / 2;
        let acc = 0;
        const segs = series.map((ser, si) => {
          const v = ser.values[i] || 0;
          if (v <= 0) return null;
          const h = hOf(v);
          const yTop = padT + plotH - hOf(acc) - h;
          acc += v;
          return { si, yTop, h, key: ser.key, v };
        }).filter(Boolean) as { si: number; yTop: number; h: number; key: string; v: number }[];
        return (
          <g key={i}>
            {segs.map((s, n) => (
              // 누적 막대의 맨 위 조각만 둥글게 — 막대 하나가 통으로 rx 를 가진 것처럼 보인다.
              <rect key={s.si} x={cx - bw / 2} y={s.yTop} width={bw} height={s.h} rx={n === segs.length - 1 ? rx : 0} fill={col(s.si)}>
                <title>{`${p} · ${s.key} ${s.v.toLocaleString()}${unit}`}</title>
              </rect>
            ))}
            {showLabel(i, periods.length) && <text x={cx} y={H - 9} textAnchor="middle" fontSize={AXIS_FS.x} fill="var(--sm-text-mid)">{p}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// 막대(왼쪽 축, 누적) + 선(오른쪽 축) 콤보 — 발송량(막대) + 운임(선). 마우스오버 시 인터랙티브 툴팁.
export function ComboBarLine({ periods, barSeries, barColors, lineValues, lineLabel = "운임", lineFmt = moneyCompact, barFmt, barUnit = "건", lineColor = CHART_LINE }: {
  periods: string[];
  barSeries: { key: string; values: number[] }[]; // 누적 막대(왼쪽 축)
  barColors: string[];
  lineValues: number[];                            // 선(오른쪽 축)
  lineLabel?: string;
  lineFmt?: (n: number) => string;
  barFmt?: (n: number) => string;                  // 왼쪽 축 포맷(금액이면 moneyCompact)
  barUnit?: string;
  lineColor?: string;
}) {
  const [hi, setHi] = useState<number | null>(null);
  if (!periods.length) return <div className="sm-faint" style={{ fontSize: 13, padding: "8px 2px" }}>데이터 없음</div>;
  const bFmt = barFmt || ((n: number) => n.toLocaleString());
  const totals = periods.map((_, i) => barSeries.reduce((s, ser) => s + (ser.values[i] || 0), 0));
  const topL = niceCeil(Math.max(...totals, 1));
  const topR = niceCeil(Math.max(...lineValues, 1));
  const { W, H, padL, padT, padB, rx, barMax, barRatio } = GEOM, padR = 56;  // 오른쪽 축 자리
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / periods.length, bw = Math.min(barMax, slot * barRatio);
  const yL = (v: number) => padT + plotH - (v / topL) * plotH;
  const yR = (v: number) => padT + plotH - (v / topR) * plotH;
  const cx = (i: number) => padL + slot * i + slot / 2;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const labelEvery = Math.ceil(periods.length / 14);
  const linePts = periods.map((_, i) => `${cx(i)},${yR(lineValues[i] || 0)}`).join(" ");
  const clamp = (v: number, lo: number, hex: number) => Math.max(lo, Math.min(hex, v));
  const hex = 92, lo = 8;
  return (
    <div style={{ position: "relative" }} onMouseLeave={() => setHi(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
        {ticks.map((f, i) => {
          const yy = yL(topL * f);
          return (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={yy} y2={yy} stroke="var(--sm-border-light)" strokeWidth="1" />
              <text x={padL - 6} y={yy + 3.5} textAnchor="end" fontSize={AXIS_FS.y} fill="var(--sm-text-light)">{bFmt(Math.round(topL * f))}</text>
              <text x={W - padR + 6} y={yR(topR * f) + 3.5} textAnchor="start" fontSize={AXIS_FS.y} fill={lineColor}>{lineFmt(Math.round(topR * f))}</text>
            </g>
          );
        })}
        {periods.map((_, i) => {
          let acc = 0;
          return (
            <g key={i}>
              {barSeries.map((ser, si) => {
                const v = ser.values[i] || 0; if (v <= 0) return null;
                const h = (v / topL) * plotH; const yTop = padT + plotH - (acc / topL) * plotH - h; acc += v;
                const isTop = !barSeries.slice(si + 1).some((s2) => (s2.values[i] || 0) > 0);  // 맨 위 조각만 둥글게
                return <rect key={si} x={cx(i) - bw / 2} y={yTop} width={bw} height={h} rx={isTop ? rx : 0} fill={barColors[si % barColors.length]} opacity={hi === null || hi === i ? 1 : 0.45} />;
              })}
            </g>
          );
        })}
        <polyline points={linePts} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" />
        {periods.map((_, i) => <circle key={i} cx={cx(i)} cy={yR(lineValues[i] || 0)} r={hi === i ? 4 : 2.4} fill={lineColor} />)}
        {periods.map((p, i) => (i % labelEvery === 0 || periods.length <= 14) ? <text key={i} x={cx(i)} y={H - 9} textAnchor="middle" fontSize="10" fill="var(--sm-text-mid)">{p}</text> : null)}
        {periods.map((_, i) => <rect key={i} x={padL + slot * i} y={padT} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setHi(i)} />)}
      </svg>
      {hi != null && (
        <div style={{ position: "absolute", left: `${clamp((cx(hi) / W) * 100, lo, hex)}%`, top: 6, transform: "translateX(-50%)", background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 8, padding: "7px 10px", fontSize: 11.5, lineHeight: 1.55, boxShadow: "0 4px 14px rgba(0,0,0,0.13)", pointerEvents: "none", whiteSpace: "nowrap", zIndex: 5 }}>
          <div style={{ fontWeight: 800, marginBottom: 2 }}>{periods[hi]}</div>
          {barSeries.map((ser, si) => <div key={si}><span style={{ color: barColors[si % barColors.length] }}>●</span> {ser.key} <strong>{(ser.values[hi] || 0).toLocaleString()}{barUnit}</strong></div>)}
          <div style={{ borderTop: "1px solid var(--sm-border)", marginTop: 3, paddingTop: 3 }}>합계 <strong>{totals[hi].toLocaleString()}{barUnit}</strong></div>
          <div style={{ color: lineColor, fontWeight: 700 }}>{lineLabel} {lineFmt(lineValues[hi] || 0)}원</div>
        </div>
      )}
    </div>
  );
}

// 분포 도넛 카드(도넛 + 값·비율 범례 행). 도넛 자체는 Donut 재사용 — 지오메트리·중앙표기가 한 벌이다.
//  colors 미지정 시 PIE_COLORS 순환. 의미축(상태·귀책 등)은 그 색 지도를 넘길 것.
export function PieCard({ title, data, fmt, colors, size = 132 }: {
  title: string;
  data: [string, number][];
  fmt?: (n: number) => string;
  colors?: string[];
  size?: number;
}) {
  const total = data.reduce((s, [, n]) => s + n, 0);
  const col = (i: number) => (colors ? colors[i % colors.length] : PIE_COLORS[i % PIE_COLORS.length]);
  return (
    <section className="b2b-card">
      <div className="b2b-card-head"><span className="b2b-card-title">{title}</span></div>
      {total === 0 ? (
        <div className="sm-faint" style={{ padding: "8px 2px", fontSize: 13 }}>데이터 없음</div>
      ) : (
        <div className="sm-row-wrap" style={{ gap: 16, alignItems: "center" }}>
          <Donut data={data} colors={colors} size={size} center={fmt ? fmt(total) : String(total)} />
          <div className="sm-col" style={{ gap: 5, minWidth: 150 }}>
            {data.map(([label, n], i) => (
              <div key={i} className="sm-between" style={{ fontSize: 13, gap: 8 }}>
                <span className="sm-row" style={{ gap: 6, minWidth: 0 }}>
                  <span className="sm-stat-hero-dot" style={{ background: col(i) }} />
                  <span className="sm-ellipsis">{label}</span>
                </span>
                <span style={{ whiteSpace: "nowrap" }}><strong>{fmt ? fmt(n) : n}</strong> <span className="sm-faint">{Math.round((n / total) * 100)}%</span></span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// 가로 막대 리스트(순위형). sub 는 항목 아래 보조 설명, minPct 는 값이 0에 가까워도
//  막대가 보이게 하는 최소 폭(%). sorted 는 값 내림차순 정렬.
export function BarList({ title, caption, data, accent, fmt, sub, minPct = 0, sorted, empty }: {
  title: string;
  caption?: React.ReactNode;      // 제목 아래 한 줄 설명
  data: [string, number][];
  accent?: string;
  fmt?: (n: number) => string;
  sub?: (label: string, n: number) => React.ReactNode;
  minPct?: number;
  sorted?: boolean;
  empty?: string;
}) {
  const rows = sorted ? [...data].sort((a, b) => b[1] - a[1]) : data;
  const max = rows.length ? Math.max(...rows.map((d) => d[1]), 1) : 1;
  return (
    <section className="b2b-card">
      <div className="b2b-card-head"><span className="b2b-card-title">{title}</span></div>
      {caption && <div className="sm-faint" style={{ fontSize: 12, marginBottom: 12 }}>{caption}</div>}
      {rows.length === 0 ? (
        <div className="sm-faint" style={{ padding: "8px 2px", fontSize: 13 }}>{empty || "데이터 없음"}</div>
      ) : (
        <div className="sm-col" style={{ gap: 8 }}>
          {rows.map(([label, n]) => {
            const pct = Math.max(minPct, Math.round((n / max) * 100));
            return (
              <div key={label} className="sm-col" style={{ gap: 3 }}>
                <div className="sm-between" style={{ fontSize: 13 }}>
                  <span className="sm-ellipsis" style={{ maxWidth: "75%" }}>{label}</span>
                  <strong>{fmt ? fmt(n) : n}</strong>
                </div>
                <div style={{ height: 7, borderRadius: 4, background: "var(--sm-bg-subtle)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: accent || "var(--sm-orange)", borderRadius: 4, transition: "width .35s ease" }} />
                </div>
                {sub && <div className="sm-faint" style={{ fontSize: 12, lineHeight: 1.5 }}>{sub(label, n)}</div>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
