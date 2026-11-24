import { baseFeeOf, ratesFor, boxCatWeights, DEFAULT_BOX_CATS, type RateVersion, type BoxCat } from "./fulfill-rates";

// 배송일지 자동입력/직접수정 병합 — 화면·통계·엑셀이 같은 '최종값'을 쓰도록 한 곳에서 파생.
//  자동입력(boxes_*, base_fee_* = 발주처리 기록) + 직접수정 보정(boxes_*_manual, ±) →
//  최종 택배량 = max(0, 자동+보정) · 최종 기본운임 = 자동운임 + Σ(보정 × 그날 박스종류 대표단가).

export type BoxCounts = Record<string, number>;

// 박스종류별 개수를 정수로 정제. signed=true 면 음수(빼기 보정) 허용.
//  ★설정에서 박스 종류를 바꿔도 과거 기록이 사라지지 않도록, '현재 목록에 없는 종류도 버리지 않는다'.
//   (예전엔 현재 목록만 훑어서, 종류 이름을 바꾸면 그 이름으로 쌓인 과거 택배량이 화면·통계·엑셀에서 조용히 증발했다.)
export function cleanBoxes(o: unknown, signed = false): BoxCounts {
  const out: BoxCounts = {};
  if (o && typeof o === "object" && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const name = String(k).trim();
      if (!name) continue;
      const raw = Math.round(Number(v) || 0);
      const n = signed ? raw : Math.max(0, raw);
      if (n !== 0) out[name] = n;
    }
  }
  return out;
}

// 여러 기록에 등장하는 모든 박스종류 = 현재 설정 목록 + 과거 데이터에만 있는 종류(뒤에 붙임).
//  표 헤더·엑셀 열은 이 순서를 쓴다 → 과거 기록이 항상 보인다.
export function unionCategories(cats: BoxCat[], ...records: (BoxCounts | null | undefined)[]): string[] {
  const order = (cats.length ? cats : DEFAULT_BOX_CATS).map((c) => c.name);
  const seen = new Set(order);
  for (const r of records) if (r) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); order.push(k); }
  return order;
}

export const sumCounts = (o: BoxCounts): number => Object.values(o).reduce((a, b) => a + b, 0);

// 최종 수량 = 자동 + 보정 (박스종류별 0 미만 방지). 현재 목록에 없는 과거 종류도 그대로 보존.
export function mergeCounts(auto: BoxCounts, manual: BoxCounts): BoxCounts {
  const out: BoxCounts = {};
  for (const c of new Set([...Object.keys(auto), ...Object.keys(manual)])) {
    const v = Math.max(0, (auto[c] || 0) + (manual[c] || 0));
    if (v > 0) out[c] = v;
  }
  return out;
}

// 보정분 운임(부호 유지) = Σ 보정개수 × 그 박스종류 대표중량의 기본운임.
//  현재 설정에 없는 과거 종류는 기본 8종 대표중량으로 폴백(이름을 바꾼 뒤에도 과거 보정분 금액이 유지되도록).
export function manualFeeDelta(manual: BoxCounts, tiers: RateVersion["boxTiers"], cats: BoxCat[] = DEFAULT_BOX_CATS): number {
  const w = { ...boxCatWeights(DEFAULT_BOX_CATS), ...boxCatWeights(cats) };
  let sum = 0;
  for (const [c, cnt] of Object.entries(manual)) {
    if (cnt && w[c] != null) sum += cnt * baseFeeOf(w[c], tiers);
  }
  return sum;
}

// ── 박스 수로 기본운임 다시 계산(2026-11-24 대표: "11월 1일부터 택배비가 바뀌어 단가를 고쳤는데 반영이 안 됐다") ──
//  발주처리에서 기록한 기본운임은 기록할 때의 단가로 저장된다 — 단가를 나중에(적용 시작일을 과거로) 넣으면 그 사이 기록은 옛 단가로 남는다.
//  기록에는 박스 종류별 개수가 있고 박스 종류 하나는 운임 구간 하나에만 속하므로(validateBoxCats), 개수 × 그 날짜 단가로 정확히 다시 계산할 수 있다.
//  perBox = 박스당 더하는 값(도착보장 가산). unknown = 무게를 알 수 없는 박스 종류(설정에서 이름이 바뀐 옛 종류) — 있으면 다시 계산하지 않는다.
export function feeFromBoxes(boxes: BoxCounts, tiers: RateVersion["boxTiers"], cats: BoxCat[] = DEFAULT_BOX_CATS, perBox = 0): { fee: number; unknown: string[] } {
  const w = { ...boxCatWeights(DEFAULT_BOX_CATS), ...boxCatWeights(cats) };
  let fee = 0; const unknown: string[] = [];
  for (const [c, cnt] of Object.entries(boxes)) {
    if (!cnt) continue;
    if (w[c] == null) { unknown.push(c); continue; }
    fee += cnt * (baseFeeOf(w[c], tiers) + perBox);
  }
  return { fee, unknown };
}
// 자동 기록 내용 서명 — 같은 날짜에 같은 서명이 이미 있으면 '같은 파일을 두 번 기록'으로 판정(운임이 바뀌면 서명도 바뀐다)
export function recordSigText(bn: BoxCounts, bg: BoxCounts, fn: number, fg: number): string {
  const norm = (o: BoxCounts) => Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join(",");
  return `${norm(bn)}|${norm(bg)}|${fn}|${fg}`;
}
// 그 날짜의 자동 기록(이력 또는 옛 방식의 칸 값)을 그 날짜 단가로 다시 계산한다. 바꿀 것이 없으면 changed = false.
export type RecalcDay = { cur_normal: number; cur_guar: number; new_normal: number; new_guar: number; changed: boolean; unknown: string[]; entries: RecordEntry[] | null };
export function recalcDay(row: Record<string, unknown>, rates: FulfillRatesLike, cats: BoxCat[], sigOf: (bn: BoxCounts, bg: BoxCounts, fn: number, fg: number) => string): RecalcDay {
  const cur_normal = Math.round(Number(row.base_fee_normal) || 0), cur_guar = Math.round(Number(row.base_fee_guar) || 0);
  const entries = cleanRecordEntries(row.record_entries);
  const unknown: string[] = [];
  const calc = (bn: BoxCounts, bg: BoxCounts) => {
    const n = feeFromBoxes(bn, rates.boxTiers, cats), g = feeFromBoxes(bg, rates.boxTiers, cats, rates.guarSurcharge);
    for (const u of [...n.unknown, ...g.unknown]) if (!unknown.includes(u)) unknown.push(u);
    return { n: n.fee, g: g.fee };
  };
  if (entries.length) {
    const next = entries.map((e) => { const f = calc(e.boxes_normal, e.boxes_guar); return { ...e, base_fee_normal: f.n, base_fee_guar: f.g, sig: sigOf(e.boxes_normal, e.boxes_guar, f.n, f.g) }; });
    const t = recordTotals(next);
    if (unknown.length) return { cur_normal, cur_guar, new_normal: cur_normal, new_guar: cur_guar, changed: false, unknown, entries: null };
    return { cur_normal, cur_guar, new_normal: t.base_fee_normal, new_guar: t.base_fee_guar, changed: t.base_fee_normal !== cur_normal || t.base_fee_guar !== cur_guar, unknown, entries: next };
  }
  // 이력이 없는 옛 기록 — 칸에 쌓인 박스 수로
  const f = calc(cleanBoxes(row.boxes_normal), cleanBoxes(row.boxes_guar));
  if (unknown.length) return { cur_normal, cur_guar, new_normal: cur_normal, new_guar: cur_guar, changed: false, unknown, entries: null };
  return { cur_normal, cur_guar, new_normal: f.n, new_guar: f.g, changed: f.n !== cur_normal || f.g !== cur_guar, unknown, entries: null };
}
type FulfillRatesLike = { boxTiers: RateVersion["boxTiers"]; guarSurcharge: number };

// 직접수정 내역 1건 — 왜 고쳤는지(note)까지 기록
export type ManualEntry = {
  id: string;
  side: "n" | "g";        // 일반/도착보장
  category: string;        // 박스종류
  qty: number;             // ±수량
  note: string;            // 내용(사유)
  at: string;              // 기록 시각(ISO)
  by?: string | null;      // 작업자
};

export function cleanEntries(o: unknown): ManualEntry[] {
  if (!Array.isArray(o)) return [];
  const out: ManualEntry[] = [];
  for (const e of o as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    const side = e.side === "g" ? "g" : "n";
    const category = String(e.category || "");
    const qty = Math.round(Number(e.qty) || 0);
    // 종류 이름은 저장 시점 목록으로 검증됨 — 여기서 현재 목록으로 다시 거르면 과거 내역이 사라진다.
    if (!category || qty === 0) continue;
    out.push({ id: String(e.id || ""), side, category, qty, note: String(e.note || ""), at: String(e.at || ""), by: (e.by as string) ?? null });
  }
  return out;
}

// 내역 → 박스종류별 보정 합(±)
export function entriesToCounts(entries: ManualEntry[], side: "n" | "g"): BoxCounts {
  const out: BoxCounts = {};
  for (const e of entries) if (e.side === side) out[e.category] = (out[e.category] || 0) + e.qty;
  for (const c of Object.keys(out)) if (out[c] === 0) delete out[c];
  return out;
}

export function addCounts(a: BoxCounts, b: BoxCounts): BoxCounts {
  const out: BoxCounts = { ...a };
  for (const [c, v] of Object.entries(b)) {
    const n = (out[c] || 0) + v;
    if (n === 0) delete out[c]; else out[c] = n;
  }
  return out;
}

// 자동입력(발주처리 '배송일지에 기록') 1건 — 배치 단위 이력. 합계 = 이력 합, 건별 되돌리기 가능.
export type RecordEntry = {
  id: string;
  at: string;                       // 기록 시각(ISO)
  by?: string | null;               // 작업자
  mode: "add" | "replace" | "baseline"; // baseline = 이력 도입 전 기존 합계(1건으로 캡처)
  boxes_normal: BoxCounts;
  boxes_guar: BoxCounts;
  base_fee_normal: number;
  base_fee_guar: number;
  sig: string;                      // 내용 서명(중복 판정: 같은 날짜 + 같은 sig = 중복)
};

export function cleanRecordEntries(o: unknown): RecordEntry[] {
  if (!Array.isArray(o)) return [];
  const out: RecordEntry[] = [];
  for (const e of o as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    out.push({
      id: String(e.id || ""),
      at: String(e.at || ""),
      by: (e.by as string) ?? null,
      mode: e.mode === "replace" ? "replace" : e.mode === "baseline" ? "baseline" : "add",
      boxes_normal: cleanBoxes(e.boxes_normal),
      boxes_guar: cleanBoxes(e.boxes_guar),
      base_fee_normal: Math.round(Number(e.base_fee_normal) || 0),
      base_fee_guar: Math.round(Number(e.base_fee_guar) || 0),
      sig: String(e.sig || ""),
    });
  }
  return out;
}

// 이력 합 → 자동입력 컬럼 값(박스 합·운임 합)
export function recordTotals(entries: RecordEntry[]): { boxes_normal: BoxCounts; boxes_guar: BoxCounts; base_fee_normal: number; base_fee_guar: number } {
  let bn: BoxCounts = {}, bg: BoxCounts = {}, fn = 0, fg = 0;
  for (const e of entries) {
    bn = addCounts(bn, e.boxes_normal);
    bg = addCounts(bg, e.boxes_guar);
    fn += e.base_fee_normal;
    fg += e.base_fee_guar;
  }
  // 자동 합계는 음수가 없어야 정상 — 방어적으로 0 미만 제거
  for (const c of Object.keys(bn)) if (bn[c] < 0) delete bn[c];
  for (const c of Object.keys(bg)) if (bg[c] < 0) delete bg[c];
  return { boxes_normal: bn, boxes_guar: bg, base_fee_normal: Math.max(0, fn), base_fee_guar: Math.max(0, fg) };
}

export type MergedDeliveryRow = Record<string, unknown> & {
  log_date: string;
  boxes_normal: BoxCounts;        // 최종(자동+보정)
  boxes_guar: BoxCounts;
  base_fee_normal: number;        // 최종 기본운임
  base_fee_guar: number;
  boxes_normal_auto: BoxCounts;   // 자동입력 원본(발주처리 기록)
  boxes_guar_auto: BoxCounts;
  base_fee_normal_auto: number;
  base_fee_guar_auto: number;
  boxes_normal_manual: BoxCounts; // 직접수정 보정 합(± = 내역 합 + 075 구컬럼 잔여)
  boxes_guar_manual: BoxCounts;
  manual_entries: ManualEntry[];  // 건별 내역(사유 포함)
  record_entries: RecordEntry[];  // 자동입력 배치 이력(되돌리기용)
  manual_updated_at: string | null;
};

// DB 행 → 최종값 병합 행. 기존 소비처(통계·엑셀)는 boxes_*/base_fee_* 를 그대로 읽으면 최종값이 된다.
export function mergeDeliveryRow(row: Record<string, unknown>, history: RateVersion[], cats: BoxCat[] = DEFAULT_BOX_CATS): MergedDeliveryRow {
  const log_date = String(row.log_date || "");
  const autoN = cleanBoxes(row.boxes_normal);
  const autoG = cleanBoxes(row.boxes_guar);
  const entries = cleanEntries(row.manual_entries);
  // 보정 합 = 내역 합 + 구컬럼(075, 내역 도입 전 저장분) 잔여값
  const manN = addCounts(cleanBoxes(row.boxes_normal_manual, true), entriesToCounts(entries, "n"));
  const manG = addCounts(cleanBoxes(row.boxes_guar_manual, true), entriesToCounts(entries, "g"));
  const rt = ratesFor(history, log_date);
  const feeN = Math.max(0, Math.round(Number(row.base_fee_normal) || 0) + manualFeeDelta(manN, rt.boxTiers, cats));
  // 도착보장 보정은 박스당 도착보장 가산(guarSurcharge)도 함께 반영
  const feeG = Math.max(0, Math.round(Number(row.base_fee_guar) || 0) + manualFeeDelta(manG, rt.boxTiers, cats) + rt.guarSurcharge * sumCounts(manG));
  return {
    ...row,
    log_date,
    boxes_normal: mergeCounts(autoN, manN),
    boxes_guar: mergeCounts(autoG, manG),
    base_fee_normal: feeN,
    base_fee_guar: feeG,
    boxes_normal_auto: autoN,
    boxes_guar_auto: autoG,
    base_fee_normal_auto: Math.round(Number(row.base_fee_normal) || 0),
    base_fee_guar_auto: Math.round(Number(row.base_fee_guar) || 0),
    boxes_normal_manual: manN,
    boxes_guar_manual: manG,
    manual_entries: entries,
    record_entries: cleanRecordEntries(row.record_entries),
    manual_updated_at: (row.manual_updated_at as string) || null,
  };
}
