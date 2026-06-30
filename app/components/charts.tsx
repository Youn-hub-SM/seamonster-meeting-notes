"use client";

// 내부도구 공용 차트 프리미티브 — 도넛 / 세로막대 추세 / 분포 도넛카드 / 가로바 리스트.
// 디자인시스템: 카테고리 구분 색은 토큰이 아닌 전용 팔레트(PIE_COLORS) 예외. 레이아웃은 .b2b-card / .sm-* 사용.

// 카테고리 구분용 팔레트(차트 전용)
export const PIE_COLORS = ["#F15A30", "#1971C2", "#22863A", "#B08800", "#C92A2A", "#7C3AED", "#0EA5A4", "#E8590C", "#6B7280", "#DB2777"];

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
export function TrendChart({ data, fmtAxis }: { data: { label: string; value: number; tip?: string }[]; fmtAxis?: (n: number) => string }) {
  if (!data.length) return <div className="sm-faint" style={{ fontSize: 13 }}>데이터 없음</div>;
  const fmt = fmtAxis || ((n: number) => n.toLocaleString());
  const top = niceCeil(Math.max(...data.map((d) => d.value), 1));
  const W = 760, H = 230, padL = 44, padR = 10, padT = 12, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / data.length, bw = Math.min(46, slot * 0.5);
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => top * f);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--sm-border-light)" strokeWidth="1" />
          <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--sm-text-light)">{fmt(Math.round(t))}</text>
        </g>
      ))}
      {data.map((d, i) => {
        const cx = padL + slot * i + slot / 2;
        const yy = y(d.value);
        return (
          <g key={i}>
            <rect x={cx - bw / 2} y={yy} width={bw} height={Math.max(0, padT + plotH - yy)} rx={4} fill="var(--sm-orange)">
              <title>{d.tip || `${d.label} · ${fmt(d.value)}`}</title>
            </rect>
            <text x={cx} y={H - 9} textAnchor="middle" fontSize="11" fill="var(--sm-text-mid)">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// 누적 세로막대 — 기간(X축) × 카테고리(누적 세그먼트). 유형별 시계열 변화용.
//  series[i].values 는 periods 와 같은 길이. 세그먼트 호버 시 "기간 · 유형 N건".
export function StackedBar({ periods, series, colors, fmtAxis }: {
  periods: string[];
  series: { key: string; values: number[] }[];
  colors?: string[];
  fmtAxis?: (n: number) => string;
}) {
  if (!periods.length || !series.length) return <div className="sm-faint" style={{ fontSize: 13, padding: "8px 2px" }}>데이터 없음</div>;
  const fmt = fmtAxis || ((n: number) => n.toLocaleString());
  const totals = periods.map((_, i) => series.reduce((s, ser) => s + (ser.values[i] || 0), 0));
  const top = niceCeil(Math.max(...totals, 1));
  const W = 760, H = 240, padL = 40, padR = 10, padT = 12, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / periods.length, bw = Math.min(46, slot * 0.62);
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
            <text x={padL - 6} y={yy + 3.5} textAnchor="end" fontSize="10.5" fill="var(--sm-text-light)">{fmt(Math.round(t))}</text>
          </g>
        );
      })}
      {periods.map((p, i) => {
        const cx = padL + slot * i + slot / 2;
        let acc = 0;
        return (
          <g key={i}>
            {series.map((ser, si) => {
              const v = ser.values[i] || 0;
              if (v <= 0) return null;
              const h = hOf(v);
              const yTop = padT + plotH - hOf(acc) - h;
              acc += v;
              return <rect key={si} x={cx - bw / 2} y={yTop} width={bw} height={h} fill={col(si)}><title>{`${p} · ${ser.key} ${v}건`}</title></rect>;
            })}
            <text x={cx} y={H - 9} textAnchor="middle" fontSize="10.5" fill="var(--sm-text-mid)">{p}</text>
          </g>
        );
      })}
    </svg>
  );
}

// 분포 도넛 카드(도넛 + 범례 행)
export function PieCard({ title, data, fmt }: { title: string; data: [string, number][]; fmt?: (n: number) => string }) {
  const total = data.reduce((s, [, n]) => s + n, 0);
  const R = 42, W = 20, cx = 60, cy = 60, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <section className="b2b-card">
      <div className="b2b-card-head"><span className="b2b-card-title">{title}</span></div>
      {total === 0 ? (
        <div className="sm-faint" style={{ padding: "8px 2px", fontSize: 13 }}>데이터 없음</div>
      ) : (
        <div className="sm-row-wrap" style={{ gap: 16, alignItems: "center" }}>
          <svg viewBox="0 0 120 120" width="118" height="118" style={{ flexShrink: 0 }}>
            {data.map(([label, n], i) => {
              const len = (n / total) * C;
              const seg = (
                <circle key={i} cx={cx} cy={cy} r={R} fill="none" stroke={PIE_COLORS[i % PIE_COLORS.length]}
                  strokeWidth={W} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off}
                  transform={`rotate(-90 ${cx} ${cy})`}><title>{`${label} ${Math.round((n / total) * 100)}%`}</title></circle>
              );
              off += len;
              return seg;
            })}
            {!fmt && <text x={cx} y={cy + 6} textAnchor="middle" fontSize="19" fontWeight="800" fill="var(--sm-black)">{total}</text>}
          </svg>
          <div className="sm-col" style={{ gap: 5, minWidth: 130, flex: 1 }}>
            {data.map(([label, n], i) => (
              <div key={i} className="sm-between" style={{ fontSize: 13, gap: 8 }}>
                <span className="sm-row" style={{ gap: 6, minWidth: 0 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: PIE_COLORS[i % PIE_COLORS.length], flexShrink: 0 }} />
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

// 가로 막대 리스트(순위형)
export function BarList({ title, data, accent, fmt }: { title: string; data: [string, number][]; accent?: string; fmt?: (n: number) => string }) {
  const max = data.length ? Math.max(...data.map((d) => d[1])) : 1;
  return (
    <section className="b2b-card">
      <div className="b2b-card-head"><span className="b2b-card-title">{title}</span></div>
      {data.length === 0 ? (
        <div className="sm-faint" style={{ padding: "8px 2px", fontSize: 13 }}>데이터 없음</div>
      ) : (
        <div className="sm-col" style={{ gap: 8 }}>
          {data.map(([label, n]) => (
            <div key={label} className="sm-col" style={{ gap: 3 }}>
              <div className="sm-between" style={{ fontSize: 13 }}>
                <span className="sm-ellipsis" style={{ maxWidth: "75%" }}>{label}</span>
                <strong>{fmt ? fmt(n) : n}</strong>
              </div>
              <div style={{ height: 7, borderRadius: 4, background: "var(--sm-bg-subtle)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.round((n / max) * 100)}%`, background: accent || "var(--sm-orange)", borderRadius: 4 }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
