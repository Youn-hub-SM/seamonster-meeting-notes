import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { cellStr, cellErrorOf } from "@/app/lib/inventory-xlsx";
import { getAllBundles, isBundleId } from "@/app/lib/product-bundles";
import { toInvChannel } from "@/app/lib/inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export type AdjustRow = { product_id: string; sku: string | null; name: string; spec: string | null; unit: string; current: number; target: number; delta: number; memo: string | null };

// POST /api/inventory/adjust/import (multipart) — 실사 엑셀 파싱 → 델타 미리보기.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return NextResponse.json({ ok: false, error: "엑셀 파일을 첨부하세요." }, { status: 400 });
    const chan = toInvChannel(form.get("channel")); // 실사 대상 채널(036·113·115, 기본 소매) — 조정은 네 칸 모두 허용

    const buf = Buffer.from(await (file as File).arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    if (!ws) return NextResponse.json({ ok: false, error: "시트를 찾을 수 없습니다." }, { status: 400 });

    const headerRow = ws.getRow(1);
    const col = new Map<string, number>();
    headerRow.eachCell((cell, c) => col.set(cellStr(cell.value), c));
    if (!col.has("SKU") || !col.has("실사수량")) return NextResponse.json({ ok: false, error: "헤더에 'SKU'·'실사수량'이 필요합니다. (양식을 받아 사용하세요)" }, { status: 400 });
    // 전 품목이 채워져 내려간 양식인지 판별 — 그 양식은 안 적은 줄이 대부분이라 오류가 아니라 '건너뜀'이 맞다.
    //  손으로 만든 파일이면 적어 넣은 행만 있는 것이므로 실사수량 누락은 실수 → 예전처럼 오류로 알린다.
    const isFilledForm = col.has("품목명") && [...col.keys()].some((h) => h.startsWith("현재고"));

    const sb = supabaseAdmin();
    // 기준 재고 = 오늘(KST)까지의 원장. 발송예정일이 미래인 선점 출고(도매·도매 대량)는 아직 선반에 있으므로 빼면 안 된다 —
    //  반영(apply)도 같은 기준·같은 거래일(오늘)로 기록해 미리보기의 현재고·조정값과 실제 기록이 일치한다.
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const stockRpc = async () => {
      const res = await sb.rpc("inventory_stock", { asof: today, chan });
      // 폴백은 (asof, chan) 시그니처가 없을 때(036 미적용, PGRST202)만 — 일시 오류까지 4칸 합으로 대체하면 델타가 통째로 틀어진다.
      if (res.error?.code !== "PGRST202") return res;
      return sb.rpc("inventory_stock", { asof: today });
    };
    const [pr, tr, bundles] = await Promise.all([
      sb.from("products").select("id, sku, name, spec, unit").eq("active", true),
      stockRpc(),
      getAllBundles(sb), // 세트는 자체 재고가 없어 조정 대상이 될 수 없다(단건 API 와 같은 규칙)
    ]);
    if (pr.error) throw pr.error;
    if (tr.error) throw tr.error;
    const bySku = new Map<string, { id: string; name: string; spec: string | null; unit: string }[]>();
    for (const p of pr.data ?? []) { const k = p.sku ? String(p.sku).trim() : ""; if (k) bySku.set(k, [...(bySku.get(k) || []), { id: p.id, name: p.name, spec: p.spec, unit: p.unit }]); }
    const stock = new Map<string, number>();
    for (const t of (tr.data as { product_id: string; qty: number }[] | null) ?? []) stock.set(t.product_id, Number(t.qty) || 0);

    let rows: AdjustRow[] = [];
    const errors: { line: number; msg: string }[] = [];
    const lineOf = new Map<string, number[]>(); // 품목별 등장 행 — 같은 품목이 두 줄이면 둘 다 제외(한 줄만 남겨도 틀린 실사값이 기록된다)
    let skipped = 0; // 실사수량 미입력 행 — 전 품목이 채워진 양식을 그대로 올리는 게 정상 사용이라 오류로 보지 않는다
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (h: string) => { const c = col.get(h); return c ? cellStr(row.getCell(c).value) : ""; };
      const sku = get("SKU").trim();
      const cellErr = cellErrorOf(row.getCell(col.get("실사수량")!).value);
      const targetRaw = cellErr ? "" : get("실사수량");
      if (!sku && !targetRaw && !cellErr) continue;
      // 채워진 양식의 빈 실사수량 = '세지 않음' — 중복으로 세지 않는다(맨 아래에 따로 적은 줄이 중복으로 빠지는 일 방지)
      if (!cellErr && targetRaw.trim() === "" && isFilledForm) { skipped++; continue; }
      // 같은 품목 중복 판정은 오류 행까지 포함해야 한다 — 한 줄이 오류로 빠지면 남은 줄의 부분 실사값이 그대로 기록된다
      const reg = (bySku.get(sku) || []).length === 1 ? bySku.get(sku)![0].id : null;
      if (reg) lineOf.set(reg, [...(lineOf.get(reg) || []), r]);
      if (cellErr) { errors.push({ line: r, msg: `실사수량 셀이 오류값(${cellErr})입니다` }); continue; }
      if (targetRaw.trim() === "") { // 품목만 있고 실사수량을 안 적은 행
        if (isFilledForm) { skipped++; continue; }
        errors.push({ line: r, msg: "실사수량이 비었습니다." }); continue;
      }
      if (!sku) { errors.push({ line: r, msg: "SKU가 비었습니다." }); continue; }
      const ids = bySku.get(sku);
      if (!ids || ids.length === 0) { errors.push({ line: r, msg: `SKU '${sku}' 품목을 찾을 수 없음` }); continue; }
      if (ids.length > 1) { errors.push({ line: r, msg: `SKU '${sku}' 가 ${ids.length}개 품목과 중복` }); continue; }
      // 세트 현재고는 구성품에서 파생된다 → 세트에 조정을 쓰면 화면엔 아무 변화 없이 원장만 더럽혀진다.
      if (isBundleId(bundles, ids[0].id)) { errors.push({ line: r, msg: `'${ids[0].name}' 은 묶음(세트)이라 조정할 수 없습니다 — 구성품 SKU 로 넣으세요` }); continue; }
      // 엄격 파싱 — '420개'·'-'·'미확인' 을 0 으로 읽으면 그 칸 재고가 0 으로 덮어써진다(xlsxNum 의 NaN→0 은 여기서 쓰지 않는다).
      const parsed = Number(targetRaw.replace(/[,\s₩]/g, ""));
      if (!Number.isFinite(parsed)) { errors.push({ line: r, msg: `실사수량 '${targetRaw}' 이(가) 숫자가 아닙니다` }); continue; }
      const target = Math.round(parsed * 100) / 100;
      if (target < 0) { errors.push({ line: r, msg: "실사수량은 0 이상" }); continue; }
      const p = ids[0];
      const current = stock.get(p.id) || 0;
      rows.push({ product_id: p.id, sku, name: p.name, spec: p.spec, unit: p.unit, current, target, delta: target - current, memo: get("메모").trim() || null });
    }
    // 같은 품목이 여러 줄이면 줄마다 같은 현재고로 델타를 만들어 조정이 겹쳐 기록된다 → 합산하지 않고 전부 거른다(사용자가 한 줄로 합쳐 다시 올린다).
    const dupIds = new Set([...lineOf].filter(([, ls]) => ls.length > 1).map(([id]) => id));
    for (const id of dupIds) { const ls = lineOf.get(id)!; for (const l of ls) errors.push({ line: l, msg: `같은 품목이 ${ls.join("·")}행에 중복 — 실사수량을 한 줄로 합쳐 주세요(이 품목은 전부 제외)` }); }
    if (dupIds.size) { rows = rows.filter((x) => !dupIds.has(x.product_id)); errors.sort((a, b) => a.line - b.line); }
    const changed = rows.filter((r) => r.delta !== 0).length;
    return NextResponse.json({ ok: true, channel: chan, summary: { valid: rows.length, changed, errors: errors.length, skipped }, rows, errors });
  } catch (err) {
    console.error("[inventory/adjust/import]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "파일 분석 실패") }, { status: 500 });
  }
}
