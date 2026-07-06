import type { supabaseAdmin } from "./supabase";
import { getAllBundles } from "./product-bundles";

// 송장 스캔 집계 — 파이썬 seamonster_invoice 도구의 웹 이식.
//  파싱(헤더 자동감지) + 묶음(세트) 구성품 전개 집계. DB엔 원자료만, 전개는 여기서 계산.

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

// 헤더 후보(부분일치). 소문자·공백제거 후 비교.
const INV_ALIASES = ["송장번호", "운송장번호", "운송장", "송장", "invoice", "tracking", "등기번호"];
const CODE_ALIASES = ["단품코드", "품목코드", "옵션코드", "상품코드", "sku", "코드"];
const QTY_ALIASES = ["주문수량", "수량합계", "수량", "qty", "quantity"];

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "");

export function findScanCols(headerCells: unknown[]): ScanCols {
  const H = headerCells.map(norm);
  const find = (aliases: string[]) => {
    const al = aliases.map(norm);
    let i = H.findIndex((h) => h && al.includes(h)); // 정확 일치 우선
    if (i >= 0) return i;
    i = H.findIndex((h) => h && al.some((a) => h.includes(a))); // 부분 일치
    return i;
  };
  return { invoice: find(INV_ALIASES), code: find(CODE_ALIASES), qty: find(QTY_ALIASES) };
}

const SEP = String.fromCharCode(1); // (송장, 코드) 병합키 경계

// 2차원 셀 배열 → 정규화된 스캔 라인. 앞 10행 안에서 헤더행 자동 탐지.
//  NOTHING 코드(정기배송 등 실물 없음) 제외, (송장·코드) 동일 라인은 수량 합산.
export function parseScanCells(cells: unknown[][]): ParsedScan {
  const empty: ParsedScan = { rows: [], invoiceCount: 0, itemCount: 0, excludedNothing: 0, cols: { invoice: -1, code: -1, qty: -1 } };
  if (!cells.length) return { ...empty, error: "빈 파일입니다." };

  let headerRow = -1;
  let cols: ScanCols = { invoice: -1, code: -1, qty: -1 };
  for (let r = 0; r < Math.min(cells.length, 10); r++) {
    const c = findScanCols(cells[r] || []);
    if (c.invoice >= 0 && c.code >= 0) { headerRow = r; cols = c; break; }
  }
  if (headerRow < 0) return { ...empty, error: "헤더에서 '송장번호'와 '단품코드' 열을 찾지 못했습니다. 열 제목을 확인하세요." };

  const merged = new Map<string, ScanRow>();
  const invoices = new Set<string>();
  let excludedNothing = 0;
  for (let r = headerRow + 1; r < cells.length; r++) {
    const row = cells[r] || [];
    const inv = String(row[cols.invoice] ?? "").trim();
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

// 상품마스터·묶음 로드 → SKU/ID 맵과 묶음 구성.
export async function loadScanMaps(sb: ReturnType<typeof supabaseAdmin>): Promise<{
  bySku: Map<string, ScanProduct>;
  byId: Map<string, ScanProduct>;
  bundles: Map<string, BundleComp[]>;
}> {
  const bySku = new Map<string, ScanProduct>();
  const byId = new Map<string, ScanProduct>();
  const { data } = await sb.from("products").select("id, sku, name");
  for (const p of (data as ScanProduct[] | null) ?? []) {
    byId.set(p.id, p);
    if (p.sku) bySku.set(String(p.sku).trim().toUpperCase(), p);
  }
  const bundles = await getAllBundles(sb);
  return { bySku, byId, bundles };
}

// 배치의 전체 라인/이벤트를 페이지네이션으로 모두 로드(PostgREST 기본 1000행 상한 회피).
async function fetchAllInvoiceItems(sb: ReturnType<typeof supabaseAdmin>, batchId: string): Promise<ScanRow[]> {
  const out: ScanRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("fulfill_scan_items")
      .select("invoice_no, sku_code, qty")
      .eq("batch_id", batchId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data as ScanRow[] | null) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}
async function fetchAllScanned(sb: ReturnType<typeof supabaseAdmin>, batchId: string): Promise<string[]> {
  const out: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("fulfill_scan_events")
      .select("invoice_no")
      .eq("batch_id", batchId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data as { invoice_no: string }[] | null) ?? [];
    out.push(...rows.map((r) => r.invoice_no));
    if (rows.length < PAGE) break;
  }
  return out;
}

// 배치 현재 상태(집계·진행) — 라인+이벤트+상품맵을 로드해 묶음 전개 집계.
export async function computeBatchState(sb: ReturnType<typeof supabaseAdmin>, batchId: string): Promise<{
  tally: TallyRow[];
  scannedCount: number;   // 스캔된 것 중 이 배치에 라인이 있는(유효) 송장 수
  totalInvoices: number;  // 배치 내 고유 송장 수
  totalUnits: number;     // 집계된 총 수량
}> {
  const [items, scannedArr, maps] = await Promise.all([
    fetchAllInvoiceItems(sb, batchId),
    fetchAllScanned(sb, batchId),
    loadScanMaps(sb),
  ]);
  const knownInvoices = new Set(items.map((r) => r.invoice_no));
  const scanned = new Set(scannedArr);
  const tally = buildScanTally(items, scanned, maps.bySku, maps.byId, maps.bundles);
  let scannedCount = 0;
  for (const inv of scanned) if (knownInvoices.has(inv)) scannedCount++;
  const totalUnits = tally.reduce((s, t) => s + t.qty, 0);
  return { tally, scannedCount, totalInvoices: knownInvoices.size, totalUnits };
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
