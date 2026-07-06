import type { supabaseAdmin } from "./supabase";
import { getAllBundles } from "./product-bundles";

// 송장 스캔 집계(단일 풀) — 파이썬 seamonster_invoice 웹 이식.
//  파싱(헤더 자동감지) + 송장번호 정규화 + 묶음(세트) 전개 집계.

export type ScanRow = { invoice_no: string; sku_code: string; qty: number };
export type ScanProduct = { id: string; sku: string | null; name: string };
export type BundleComp = { component_id: string; qty: number };
export type TallyRow = { key: string; sku: string; name: string; qty: number; unknown: boolean };
export type ScanCols = { invoice: number; code: number; qty: number };
export type ParsedScan = {
  rows: ScanRow[];
  invoiceCount: number;
  itemCount: number;
  excludedNothing: number;
  cols: ScanCols;
  error?: string;
};

// 송장번호 정규화 — 하이픈·공백 등 비영숫자 제거 후 대문자. 바코드('-' 없음)와 파일('-' 있음)을 동일 취급.
export const normInvoice = (s: unknown) => String(s ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();

// 헤더 후보(별칭). 소문자·공백(줄바꿈 포함) 제거 후 비교. 목록 앞일수록 우선순위 높음.
//  · 운송장번호(CJ 파일접수) = 송장번호. 고객주문번호는 송장이 아니므로 별칭에서 제외.
//  · 상품코드/단품코드 둘 다 후보 — CJ 파일은 '상품코드'에 SKU가 있고 '단품코드'는 비어있어,
//    실제 데이터가 있는 열을 고르도록 parseScanCells 에서 처리(빈 열 회피).
//  · 내품수량(실제 품목수)을 박스 '수량'보다 우선.
const INV_ALIASES = ["송장번호", "운송장번호", "운송장", "송장", "invoice", "tracking", "등기번호"];
const CODE_ALIASES = ["단품코드", "상품코드", "품목코드", "옵션코드", "sku", "코드"];
const QTY_ALIASES = ["내품수량", "주문수량", "수량합계", "수량", "qty", "quantity"];

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "");

// 별칭 우선순위대로(정확 일치 → 부분 일치) 후보 열 인덱스 목록.
function colCandidates(H: string[], aliases: string[]): number[] {
  const al = aliases.map(norm);
  const out: number[] = [];
  const push = (i: number) => { if (i >= 0 && !out.includes(i)) out.push(i); };
  for (const a of al) H.forEach((h, i) => { if (h === a) push(i); });          // 정확 일치
  for (const a of al) H.forEach((h, i) => { if (h && h.includes(a)) push(i); }); // 부분 일치
  return out;
}

export function findScanCols(headerCells: unknown[]): ScanCols {
  const H = headerCells.map(norm);
  const first = (aliases: string[]) => { const c = colCandidates(H, aliases); return c.length ? c[0] : -1; };
  return { invoice: first(INV_ALIASES), code: first(CODE_ALIASES), qty: first(QTY_ALIASES) };
}

const SEP = String.fromCharCode(1); // (송장, 코드) 병합키 경계

// 2차원 셀 배열 → 정규화된 스캔 라인. 앞 10행 안에서 헤더행 자동 탐지.
//  NOTHING 코드(실물 없음) 제외, 송장번호 정규화, (송장,코드) 동일 라인은 수량 합산.
export function parseScanCells(cells: unknown[][]): ParsedScan {
  const empty: ParsedScan = { rows: [], invoiceCount: 0, itemCount: 0, excludedNothing: 0, cols: { invoice: -1, code: -1, qty: -1 } };
  if (!cells.length) return { ...empty, error: "빈 파일입니다." };

  let headerRow = -1;
  for (let r = 0; r < Math.min(cells.length, 10); r++) {
    const c = findScanCols(cells[r] || []);
    if (c.invoice >= 0 && c.code >= 0) { headerRow = r; break; }
  }
  if (headerRow < 0) return { ...empty, error: "헤더에서 '송장번호'와 '상품코드(단품코드)' 열을 찾지 못했습니다. 열 제목을 확인하세요." };

  // 최종 열 결정: 후보 중 '데이터가 있는' 첫 열을 선택(빈 단품코드 열 등 회피).
  const H = (cells[headerRow] || []).map(norm);
  const sample = cells.slice(headerRow + 1, headerRow + 51);
  const hasData = (c: number) => c >= 0 && sample.some((row) => String((row || [])[c] ?? "").trim() !== "");
  const resolve = (aliases: string[]) => {
    const cands = colCandidates(H, aliases);
    for (const c of cands) if (hasData(c)) return c;
    return cands.length ? cands[0] : -1;
  };
  const cols: ScanCols = { invoice: resolve(INV_ALIASES), code: resolve(CODE_ALIASES), qty: resolve(QTY_ALIASES) };
  if (cols.invoice < 0 || cols.code < 0) return { ...empty, error: "헤더에서 '송장번호'와 '상품코드(단품코드)' 열을 찾지 못했습니다. 열 제목을 확인하세요." };

  const merged = new Map<string, ScanRow>();
  const invoices = new Set<string>();
  let excludedNothing = 0;
  for (let r = headerRow + 1; r < cells.length; r++) {
    const row = cells[r] || [];
    const inv = normInvoice(row[cols.invoice]);       // 하이픈·공백 제거 정규화
    const code = String(row[cols.code] ?? "").trim();
    if (!inv && !code) continue;
    if (!inv || !code) continue; // 불완전 행 건너뜀
    if (/NOTHING/i.test(code)) { excludedNothing++; continue; }
    const qtyRaw = cols.qty >= 0 ? String(row[cols.qty] ?? "").replace(/[^0-9.\-]/g, "") : "1";
    const qty = Math.round(Number(qtyRaw) || 0);
    if (!qty) continue;
    invoices.add(inv);
    const k = inv + SEP + code.toUpperCase();
    const ex = merged.get(k);
    if (ex) ex.qty += qty;
    else merged.set(k, { invoice_no: inv, sku_code: code, qty });
  }
  const rows = [...merged.values()];
  return { rows, invoiceCount: invoices.size, itemCount: rows.length, excludedNothing, cols };
}

// 간단 CSV 파서(따옴표·쉼표 처리). BOM 제거.
export function parseCsv(text: string): unknown[][] {
  const s = text.replace(/^﻿/, "");
  const out: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); out.push(row); row = []; field = ""; }
    else if (ch === "\r") { /* skip */ }
    else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); out.push(row); }
  return out;
}

type ScanMaps = { bySku: Map<string, ScanProduct>; byId: Map<string, ScanProduct>; bundles: Map<string, BundleComp[]> };

// 상품마스터·묶음은 자주 안 바뀌므로 인메모리 캐시(60초). 스캔마다 재로드하지 않아 응답이 빨라짐.
let _mapCache: { maps: ScanMaps; at: number } | null = null;
const MAP_TTL = 60_000;

// 상품마스터·묶음 로드 → SKU/ID 맵과 묶음 구성. (캐시 히트 시 DB 미접근)
export async function loadScanMaps(sb: ReturnType<typeof supabaseAdmin>): Promise<ScanMaps> {
  if (_mapCache && Date.now() - _mapCache.at < MAP_TTL) return _mapCache.maps;
  const bySku = new Map<string, ScanProduct>();
  const byId = new Map<string, ScanProduct>();
  const { data } = await sb.from("products").select("id, sku, name");
  for (const p of (data as ScanProduct[] | null) ?? []) {
    byId.set(p.id, p);
    if (p.sku) bySku.set(String(p.sku).trim().toUpperCase(), p);
  }
  const bundles = await getAllBundles(sb);
  const maps: ScanMaps = { bySku, byId, bundles };
  _mapCache = { maps, at: Date.now() };
  return maps;
}

// 풀 전체 라인/이벤트를 페이지네이션으로 로드(PostgREST 기본 1000행 상한 회피).
async function fetchAllItems(sb: ReturnType<typeof supabaseAdmin>): Promise<ScanRow[]> {
  const out: ScanRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("fulfill_scan_items").select("invoice_no, sku_code, qty").range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data as ScanRow[] | null) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}
async function fetchAllScanned(sb: ReturnType<typeof supabaseAdmin>): Promise<string[]> {
  const out: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("fulfill_scan_events").select("invoice_no").range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data as { invoice_no: string }[] | null) ?? [];
    out.push(...rows.map((r) => r.invoice_no));
    if (rows.length < PAGE) break;
  }
  return out;
}

// 스캔된 송장들의 라인만 로드(.in 청크). 풀 전체가 아니라 스캔셋(자주 초기화라 작음)만 → 빠름.
async function fetchScannedItems(sb: ReturnType<typeof supabaseAdmin>, scanned: string[]): Promise<ScanRow[]> {
  const out: ScanRow[] = [];
  for (let i = 0; i < scanned.length; i += 200) {
    const chunk = scanned.slice(i, i + 200);
    const { data, error } = await sb.from("fulfill_scan_items").select("invoice_no, sku_code, qty").in("invoice_no", chunk);
    if (error) throw error;
    out.push(...((data as ScanRow[] | null) ?? []));
  }
  return out;
}

// 집계(핫 경로) — '스캔된 송장'의 라인만 로드해 묶음 전개. 풀 전체를 안 읽어 스캔마다 빠름.
export async function computeTally(sb: ReturnType<typeof supabaseAdmin>): Promise<{
  tally: TallyRow[]; scannedCount: number; totalUnits: number;
}> {
  const scanned = await fetchAllScanned(sb);
  if (scanned.length === 0) return { tally: [], scannedCount: 0, totalUnits: 0 };
  const [items, maps] = await Promise.all([fetchScannedItems(sb, scanned), loadScanMaps(sb)]);
  const scannedSet = new Set(scanned);
  const knownScanned = new Set(items.map((r) => r.invoice_no));
  const tally = buildScanTally(items, scannedSet, maps.bySku, maps.byId, maps.bundles);
  let scannedCount = 0;
  for (const inv of scannedSet) if (knownScanned.has(inv)) scannedCount++;
  const totalUnits = tally.reduce((s, t) => s + t.qty, 0);
  return { tally, scannedCount, totalUnits };
}

// 풀 전체 상태(콜드 경로: 최초 로드·폴링·초기화) — 집계 + 풀의 고유 송장 수(대상 건수).
export async function computePoolState(sb: ReturnType<typeof supabaseAdmin>): Promise<{
  tally: TallyRow[]; scannedCount: number; totalInvoices: number; totalUnits: number;
}> {
  const [tally, poolInvoices] = await Promise.all([
    computeTally(sb),
    fetchAllItems(sb).then((items) => new Set(items.map((r) => r.invoice_no)).size),
  ]);
  return { ...tally, totalInvoices: poolInvoices };
}

// 스캔된 송장들의 라인을 묶음 전개하여 상품별 누적 수량 산출.
export function buildScanTally(
  items: ScanRow[],
  scanned: Set<string>,
  bySku: Map<string, ScanProduct>,
  byId: Map<string, ScanProduct>,
  bundles: Map<string, BundleComp[]>,
): TallyRow[] {
  const acc = new Map<string, { sku: string; name: string; qty: number; unknown: boolean }>();
  const addLeaf = (key: string, sku: string, name: string, qty: number, unknown: boolean) => {
    const cur = acc.get(key);
    if (cur) cur.qty += qty;
    else acc.set(key, { sku, name, qty, unknown });
  };
  const expand = (sku: string, qty: number, depth: number) => {
    const code = sku.trim();
    const p = bySku.get(code.toUpperCase());
    if (!p) { addLeaf(`?:${code.toUpperCase()}`, code, `미등록 코드: ${code}`, qty, true); return; }
    const comps = bundles.get(p.id);
    if (comps && comps.length && depth < 8) {
      for (const c of comps) {
        const cp = byId.get(c.component_id);
        if (cp && cp.sku) expand(cp.sku, qty * c.qty, depth + 1);
        else if (cp) addLeaf(cp.id, cp.sku || "", cp.name, qty * c.qty, false);
        else addLeaf(`?id:${c.component_id}`, "", "삭제된 구성품", qty * c.qty, true);
      }
    } else {
      addLeaf(p.id, p.sku || "", p.name, qty, false);
    }
  };
  for (const it of items) {
    if (!scanned.has(it.invoice_no)) continue;
    if (!it.qty) continue;
    expand(it.sku_code, it.qty, 0);
  }
  return [...acc.entries()]
    .map(([key, v]) => ({ key, sku: v.sku, name: v.name, qty: v.qty, unknown: v.unknown }))
    .sort((a, b) => (a.unknown === b.unknown ? a.name.localeCompare(b.name, "ko") : a.unknown ? 1 : -1));
}
