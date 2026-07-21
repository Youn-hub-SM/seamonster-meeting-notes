import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { buildCnplus, type CodeInfo } from "@/app/lib/order-fulfill";
import { getAllBundles } from "@/app/lib/product-bundles";
import { normalizeHistory, ratesFor } from "@/app/lib/fulfill-rates";
import { itemsSig, orderKey } from "@/app/lib/fulfill-sig";
import { getDedupConfig } from "@/app/lib/fulfill-dedup";
import ExcelJS from "exceljs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function cellVal(cell: ExcelJS.Cell): unknown {
  const v = cell.value as unknown;
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return o.result ?? "";                 // 수식 → 결과값
    if ("text" in o) return o.text ?? "";                     // 하이퍼링크
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
  }
  return v;
}

async function toXlsxB64(headers: string[], rows: unknown[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r as ExcelJS.CellValue[]);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString("base64");
}

// POST (multipart: file, keywords) — 주문 엑셀(A~M) → CNplus 일반/도착보장 파일 생성.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const keywords = String(form.get("keywords") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!file) return NextResponse.json({ ok: false, error: "엑셀 파일을 첨부하세요." }, { status: 400 });

    const wb = new ExcelJS.Workbook();
    const buf = Buffer.from(await file.arrayBuffer());
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    if (!ws) return NextResponse.json({ ok: false, error: "시트를 찾을 수 없습니다." }, { status: 400 });
    if (ws.columnCount < 13) return NextResponse.json({ ok: false, error: `열 수가 부족합니다(최소 13열, 현재 ${ws.columnCount}).` }, { status: 400 });

    // 헤더 1행 제외, A~M(13열) 데이터행
    let rows: unknown[][] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const arr: unknown[] = [];
      let any = false;
      for (let c = 1; c <= 13; c++) { const v = cellVal(ws.getRow(r).getCell(c)); arr.push(v); if (String(v).trim() !== "") any = true; }
      if (any) rows.push(arr);
    }
    if (rows.length === 0) return NextResponse.json({ ok: false, error: "데이터 행이 없습니다." }, { status: 400 });

    const sb = supabaseAdmin();

    // ── 이미 출고 처리된 주문 자동 제외(079) — 누적 다운로드 파일 등에서 처리 완료 주문이 섞여 와도
    //    CN파일·택배량·배송일지·출고 전부에서 걸러낸다. 설정(온라인발주>단가설정 '중복 방지')로 on/off·기준·창 조정.
    //    판정 기본 = '주문번호(B열) + 상품 구성(단품코드:수량 정렬)' 모두 동일. 'order_only'면 주문번호만.
    const dedup = await getDedupConfig();
    const compByOrder = new Map<string, string[]>(); // 주문번호 → ["SKU:수량", ...] (파일 내 그 주문의 전체 라인)
    for (const r of rows) {
      const orderNo = String(r[1] ?? "").trim();
      if (!orderNo) continue;
      const arr = compByOrder.get(orderNo) || [];
      arr.push(`${String(r[10] ?? "").trim().toUpperCase()}:${Math.round(Number(r[8]) || 0)}`); // K열 단품코드 : I열 수량
      compByOrder.set(orderNo, arr);
    }
    const keyOf = (orderNo: string) => dedup.match === "order_only"
      ? orderKey(orderNo)
      : orderKey(`${orderNo}|${(compByOrder.get(orderNo) || []).slice().sort().join(",")}`);
    let excludedProcessed = 0;
    const excludedOrderNos: string[] = [];
    if (dedup.enabled) try {
      const since = new Date(Date.now() - dedup.windowDays * 86400e3).toISOString();
      const { data: keyRows, error: kErr } = await sb.from("fulfill_order_keys").select("key").gte("processed_at", since);
      if (!kErr && keyRows) {
        const processed = new Set(keyRows.map((k) => k.key as string));
        if (processed.size) {
          const seen = new Set<string>();
          rows = rows.filter((r) => {
            const orderNo = String(r[1] ?? "").trim(); // B열 주문번호
            if (!orderNo || !processed.has(keyOf(orderNo))) return true;
            if (!seen.has(orderNo)) { seen.add(orderNo); excludedOrderNos.push(orderNo); }
            return false;
          });
          excludedProcessed = seen.size;
        }
        // 오래된 키 정리(창의 2배 또는 90일 중 큰 값) — 실패 무시
        const cutoff = new Date(Date.now() - Math.max(90, dedup.windowDays * 2) * 86400e3).toISOString();
        sb.from("fulfill_order_keys").delete().lt("processed_at", cutoff).then(() => {});
      }
    } catch { /* 079 미적용 — 필터 없이 진행 */ }
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: `모든 주문(${excludedProcessed}건)이 이미 출고 처리된 주문입니다. 새 주문이 없는 파일이거나, 이전에 처리한 파일을 다시 올린 것으로 보입니다.` }, { status: 400 });
    }

    // 택배 코드 = 상품마스터(courier_name·courier_weight)
    const { data: codes, error } = await sb.from("products").select("id, sku, courier_name, courier_weight").not("sku", "is", null);
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (054 적용 확인)` }, { status: 500 });

    // 묶음(세트)인데 택배중량이 미입력(0)이면 구성품 택배중량 × 수량 합으로 자동 폴백 —
    //  중량 0 → 최저 박스타입/운임으로 조용히 잘못 계산되는 것을 방지. (037 미적용이면 빈 맵 → 폴백 없음)
    const bundles = await getAllBundles(sb);
    const weightById = new Map<string, number>();
    for (const c of codes ?? []) weightById.set(c.id as string, Number(c.courier_weight) || 0);
    const bundleWeight = (pid: string): number => {
      const comps = bundles.get(pid);
      if (!comps || !comps.length) return 0;
      return comps.reduce((s, cm) => s + (weightById.get(cm.component_id) || 0) * cm.qty, 0);
    };

    const codeMap = new Map<string, CodeInfo>();
    for (const c of codes ?? []) {
      const sku = String(c.sku || "").trim();
      if (!sku) continue;
      let w = Number(c.courier_weight) || 0;
      if (w <= 0 && bundles.has(c.id as string)) w = Math.round(bundleWeight(c.id as string) * 100) / 100;
      codeMap.set(sku.toUpperCase(), { courier_name: c.courier_name || "", order_weight: w });
    }

    // 요율(설정) 로드 — 처리일(오늘, KST)에 유효한 단가. 미설정이면 기본값
    const { data: rateRow } = await sb.from("b2b_settings").select("value").eq("key", "fulfill_rates").maybeSingle();
    const rates = ratesFor(normalizeHistory(rateRow?.value ?? {}), new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10));

    const res = buildCnplus(rows, codeMap, keywords, rates);

    // 이 파일의 주문 키(주문번호+구성)를 배치 서명으로 임시 보관 — 4단계 '출고 완료' 때 확정 등록(079). 실패해도 진행.
    try {
      const keys = [...new Set(rows.map((r) => String(r[1] ?? "").trim()).filter(Boolean).map(keyOf))];
      if (keys.length && res.outbound.length) {
        await sb.from("fulfill_pending_keys").upsert(
          { sig: itemsSig(res.outbound), keys, created_at: new Date().toISOString() },
          { onConflict: "sig" }
        );
      }
    } catch { /* 079 미적용 — 스킵 */ }

    const d = new Date(Date.now() + 9 * 3600e3);
    const stamp = `${d.toISOString().slice(0, 10).replace(/-/g, "")}_${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const normalB64 = await toXlsxB64(res.headers, res.normal);
    const guarB64 = res.guarantee.length ? await toXlsxB64(res.headers, res.guarantee) : null;

    // 택배량 집계 xlsx (박스종류 × 일반/도착보장)
    const parcelRows: unknown[][] = res.parcelSummary.map((p) => [p.category, p.normal, p.guarantee, p.normal + p.guarantee]);
    parcelRows.push(["합계", res.stats.parcels - res.stats.parcelsGuar, res.stats.parcelsGuar, res.stats.parcels]);
    const parcelB64 = await toXlsxB64(["박스종류", "일반", "도착보장", "합계"], parcelRows);

    return NextResponse.json({
      ok: true,
      stats: res.stats,
      fees: res.fees,
      parcelSummary: res.parcelSummary,
      addressWarnings: res.addressWarnings,
      unmatched: res.unmatched,
      outbound: res.outbound, // SKU별 출고수량(재고 출고 연동용) — PII 없음
      excludedProcessed,                          // 이미 출고 처리돼 자동 제외한 주문 수
      excludedOrderNos: excludedOrderNos.slice(0, 10), // 표시용 일부
      codeCount: codeMap.size,
      files: {
        normal: { name: `cnplus_출력_${stamp}.xlsx`, b64: normalB64 },
        guarantee: guarB64 ? { name: `[도착보장]cnplus_출력_${stamp}.xlsx`, b64: guarB64 } : null,
        parcel: { name: `택배량_${stamp}.xlsx`, b64: parcelB64 },
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "생성 실패") }, { status: 500 });
  }
}
