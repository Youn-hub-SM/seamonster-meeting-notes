import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { buildCnplus, type CodeInfo } from "@/app/lib/order-fulfill";
import { getAllBundles } from "@/app/lib/product-bundles";
import { normalizeHistory, ratesFor, normalizeBoxCats } from "@/app/lib/fulfill-rates";
import { batchSig, orderKey } from "@/app/lib/fulfill-sig";
import { getDedupConfig } from "@/app/lib/fulfill-dedup";
import { chunks, fetchSkuProducts, interruptedGroups, missingColumn, missingTable, kstToday } from "@/app/lib/fulfill-db";
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

type Sb = ReturnType<typeof supabaseAdmin>;
type OpenOverlap = { orders: number; batches: { fileName: string | null; at: string }[] } | { error: true };

// CN 파일을 받았지만(downloaded_at) 출고 완료·폐기 안 한 다른 배치(최근 3일)와 이 파일 주문이 겹치는지(135).
//  겹침 판정 = 이 파일의 현재 기준 키 ∩ 그 배치의 키(두 산식 모두 저장) — 판정 기준을 바꿔도 맞는다.
//  135 미적용이면 null(확인 안 함). 조회 오류는 { error } — 화면이 '확인 실패'로 알린다.
async function findOpenOverlap(sb: Sb, sig: string, matchKeys: Set<string>): Promise<OpenOverlap | null> {
  const since = new Date(Date.now() - 3 * 86400e3).toISOString();
  type P = { sig: string; keys: unknown; file_name: string | null; downloaded_at: string };
  const open: P[] = [];
  for (let i = 0; i < 2000; i += 200) {
    const { data, error } = await sb.from("fulfill_pending_keys").select("sig, keys, file_name, downloaded_at")
      .not("downloaded_at", "is", null).is("discarded_at", null).gte("created_at", since).neq("sig", sig)
      .order("sig", { ascending: true }).range(i, i + 199);
    if (error) return missingColumn(error, /downloaded_at|discarded_at|file_name/i) || missingTable(error) ? null : { error: true };
    open.push(...((data ?? []) as P[]));
    if ((data ?? []).length < 200) break;
  }
  if (!open.length) return { orders: 0, batches: [] };
  // 이미 출고 완료된 배치(대기 키 삭제가 실패해 남은 행)는 뺀다
  const done = new Set<string>();
  for (const part of chunks(open.map((o) => o.sig), 150)) {
    const { data, error } = await sb.from("fulfill_dispatch").select("sig").in("sig", part);
    if (error) return { error: true };
    for (const r of data ?? []) done.add(r.sig as string);
  }
  const hit = new Set<string>();
  const batches: { fileName: string | null; at: string }[] = [];
  for (const o of open) {
    if (done.has(o.sig)) continue;
    const theirs = Array.isArray(o.keys) ? (o.keys as string[]) : [];
    let n = 0;
    for (const k of theirs) if (matchKeys.has(k) && !hit.has(k)) { hit.add(k); n++; }
    if (n) batches.push({ fileName: o.file_name, at: o.downloaded_at });
  }
  return { orders: hit.size, batches: batches.slice(0, 5) };
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
    // 등록은 두 산식 키를 모두 저장 — 설정의 판정 기준(match)을 나중에 바꿔도 기존 처리완료 기록이
    //  전부 미스나 '이미 처리된 주문 제외'가 조용히 무효화되던 결함(감사 확정) 방지. 조회는 현재 기준만.
    const keyBoth = (orderNo: string): string[] => [...new Set([
      orderKey(orderNo),
      orderKey(`${orderNo}|${(compByOrder.get(orderNo) || []).slice().sort().join(",")}`),
    ])];
    let excludedProcessed = 0;
    const excludedOrderNos: string[] = [];
    let dedupSkipped = false; // 079 미적용(표 없음)일 때만 — 조회 오류는 아래에서 멈춘다
    let interruptedResume = false; // 중단된 출고 배치 파일을 다시 올림 — 그 주문을 빼지 않았다(④에서 이어서 차감)
    let interruptedExcluded = 0;   // 제외한 주문 중 중단된 출고(재고 미차감)의 주문 수
    if (dedup.enabled) {
      // 이 파일의 주문 키만 .in() 으로 나눠 읽는다 — 창 전체를 한 번에 읽으면 서버 Max Rows(1000)에 잘려
      //  이미 출고한 주문이 '새 주문'으로 다시 실렸다(S4). 읽는 행 수 = 이 파일 주문 수 이하.
      const since = new Date(Date.now() - dedup.windowDays * 86400e3).toISOString();
      const fileKeys = [...new Set([...compByOrder.keys()].map(keyOf))];
      const processed = new Set<string>();
      const keyGroup = new Map<string, string>(); // 키 → 그 키를 등록한 출고 배치(135 group_id)
      let withGroup = true;
      for (const part of chunks(fileKeys, 150)) {
        let r = withGroup
          ? await sb.from("fulfill_order_keys").select("key, group_id").in("key", part).gte("processed_at", since)
          : await sb.from("fulfill_order_keys").select("key").in("key", part).gte("processed_at", since);
        if (r.error && withGroup && missingColumn(r.error, /group_id/i)) { withGroup = false; r = await sb.from("fulfill_order_keys").select("key").in("key", part).gte("processed_at", since); } // 135 미적용
        const kErr = r.error;
        if (kErr) {
          if (missingTable(kErr)) { dedupSkipped = true; break; }
          return NextResponse.json({ ok: false, error: `이미 처리된 주문 확인에 실패했습니다 — 다시 올려 주세요. (${kErr.message})` }, { status: 500 });
        }
        for (const k of (r.data ?? []) as { key: string; group_id?: string | null }[]) { processed.add(k.key); if (k.group_id) keyGroup.set(k.key, k.group_id); }
      }
      // 중단된 출고(이력·키만 있고 재고 행 0)가 등록한 키 — 실물은 그 CN 으로 나갔으니 기본은 '처리됨'으로 뺀다(다시 실으면 두 번 발송).
      //  단 그 배치 파일을 그대로 다시 올린 것이면(남는 주문 키 집합 = 그 배치의 대기 키) 빼지 않는다 — 같은 서명이 되어
      //  ④에서 '재고 기록이 없는 앞선 출고' 확인 뒤 이어서 차감된다. 그러지 않으면 그 배치는 영영 차감할 길이 없다(S12).
      //  기간 제한 없음 — ④도 같은 서명의 중단 배치를 날짜와 무관하게 찾는다(어긋나면 겹침 409 로 막혀 다시 올리기만 반복됐다).
      if (keyGroup.size) {
        let ghosts: Map<string, string>;
        try { ghosts = await interruptedGroups(sb, [...keyGroup.values()]); }
        catch (e) { return NextResponse.json({ ok: false, error: `이미 처리된 주문 확인에 실패했습니다 — 다시 올려 주세요. (${extractErrorMsg(e, "출고 이력 조회 실패")})` }, { status: 500 });}
        const ghostKeys = new Set([...keyGroup].filter(([, g]) => ghosts.has(g)).map(([k]) => k));
        if (ghostKeys.size) {
          const candKeys = new Set([...compByOrder.keys()].filter((o) => !processed.has(keyOf(o)) || ghostKeys.has(keyOf(o))).flatMap(keyBoth));
          const { data: pk, error: pe } = await sb.from("fulfill_pending_keys").select("sig, keys").in("sig", [...new Set(ghosts.values())]);
          if (pe && !missingTable(pe)) return NextResponse.json({ ok: false, error: `이미 처리된 주문 확인에 실패했습니다 — 다시 올려 주세요. (${pe.message})` }, { status: 500 });
          const same = (pk ?? []).some((p) => {
            const ks = Array.isArray(p.keys) ? (p.keys as string[]) : [];
            return ks.length === candKeys.size && ks.every((k) => candKeys.has(k));
          });
          if (same) { for (const k of ghostKeys) processed.delete(k); interruptedResume = true; }
          else interruptedExcluded = [...compByOrder.keys()].filter((o) => ghostKeys.has(keyOf(o))).length;
        }
      }
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
      if (!dedupSkipped) {
        // 오래된 키 정리(창의 2배 또는 90일 중 큰 값) — 실패 무시
        const cutoff = new Date(Date.now() - Math.max(90, dedup.windowDays * 2) * 86400e3).toISOString();
        sb.from("fulfill_order_keys").delete().lt("processed_at", cutoff).then(() => {});
      }
    }
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: `모든 주문(${excludedProcessed}건)이 이미 출고 처리된 주문입니다. 새 주문이 없는 파일이거나, 이전에 처리한 파일을 다시 올린 것으로 보입니다.${interruptedExcluded ? ` 그중 ${interruptedExcluded}건은 재고가 안 빠진 중단된 출고의 주문입니다 — 그 배치의 원래 파일을 그대로 다시 올려 ④ 상품 출고를 마치세요.` : ""}` }, { status: 400 });
    }

    // 택배 코드 = 상품마스터(courier_name·courier_weight) — 페이지 나눠 전량(잘리면 뒤쪽 SKU 가 미등록·중량 0)
    let codes: { id: string; sku: string | null; courier_name: string | null; courier_weight: number | null }[];
    try { codes = await fetchSkuProducts(sb, "id, sku, courier_name, courier_weight"); }
    catch (e) { return NextResponse.json({ ok: false, error: `${extractErrorMsg(e, "상품 조회 실패")} (054 적용 확인)` }, { status: 500 }); }

    // 묶음(세트)인데 택배중량이 미입력(0)이면 구성품 택배중량 × 수량 합으로 자동 폴백 —
    //  중량 0 → 최저 박스타입/운임으로 조용히 잘못 계산되는 것을 방지. (037 미적용이면 빈 맵 → 폴백 없음)
    const bundles = await getAllBundles(sb);
    const weightById = new Map<string, number>();
    for (const c of codes) weightById.set(c.id, Number(c.courier_weight) || 0);
    const bundleWeight = (pid: string): number => {
      const comps = bundles.get(pid);
      if (!comps || !comps.length) return 0;
      return comps.reduce((s, cm) => s + (weightById.get(cm.component_id) || 0) * cm.qty, 0);
    };

    const codeMap = new Map<string, CodeInfo>();
    for (const c of codes) {
      const sku = String(c.sku || "").trim();
      if (!sku) continue;
      let w = Number(c.courier_weight) || 0;
      if (w <= 0 && bundles.has(c.id)) w = Math.round(bundleWeight(c.id) * 100) / 100;
      codeMap.set(sku.toUpperCase(), { courier_name: c.courier_name || "", order_weight: w });
    }

    // 요율(설정) 로드 — 처리일(오늘, KST)에 유효한 단가. 미설정이면 기본값. 조회 오류면 멈춘다 —
    //  기본 단가로 대신하면 CN 파일 기본운임·배송일지 운임이 틀린 값으로 나간다(S4).
    const { data: rateRow, error: rateErr } = await sb.from("b2b_settings").select("value").eq("key", "fulfill_rates").maybeSingle();
    if (rateErr) return NextResponse.json({ ok: false, error: `단가 설정을 읽지 못했습니다 — 다시 올려 주세요. (${rateErr.message})` }, { status: 500 });
    const rates = ratesFor(normalizeHistory(rateRow?.value ?? {}), kstToday());
    const boxCats = normalizeBoxCats((rateRow?.value as { boxCats?: unknown })?.boxCats); // 배송일지 박스 종류(설정)

    const res = buildCnplus(rows, codeMap, keywords, rates, boxCats);

    // 이 파일의 주문 키(두 산식 모두)를 배치 서명으로 임시 보관 — ④ '출고 완료' 때 확정 등록(079).
    //  서명은 주문 키까지 섞은 batchSig — SKU 합이 같은 별개 파일과 충돌하지 않는다.
    //  저장 실패를 무시하면 ④ 출고 뒤에도 이 주문들이 '처리됨'으로 남지 않아 다음 누적 파일에 다시 실린다 → 멈춘다.
    const orderNos = [...new Set(rows.map((r) => String(r[1] ?? "").trim()).filter(Boolean))];
    const keys = [...new Set(orderNos.flatMap(keyBoth))];
    const matchKeys = [...new Set(orderNos.map(keyOf))]; // 현재 판정 기준(주문당 1개) — 커밋 때 재확인(135)
    const sig = batchSig(res.outbound, keys);
    let hasKeys = false;
    if (keys.length && res.outbound.length) {
      const now = new Date().toISOString();
      const totalQty = res.outbound.reduce((s, o) => s + (Number(o.qty) || 0), 0);
      let up = await sb.from("fulfill_pending_keys").upsert(
        { sig, keys, match_keys: matchKeys, created_at: now, file_name: file.name.slice(0, 200), order_count: orderNos.length, total_qty: totalQty },
        { onConflict: "sig" },
      );
      if (up.error && missingColumn(up.error, /match_keys|file_name|order_count|total_qty/i)) {
        up = await sb.from("fulfill_pending_keys").upsert({ sig, keys, created_at: now }, { onConflict: "sig" }); // 135 미적용
      }
      if (up.error && !missingTable(up.error)) {
        return NextResponse.json({ ok: false, error: `분석 기록 저장에 실패했습니다 — 다시 올려 주세요. (${up.error.message})` }, { status: 500 });
      }
      hasKeys = !up.error;
    }

    // CN 을 받았지만 아직 출고 완료 안 한 다른 배치(최근 3일)와 주문이 겹치는지 — 겹치면 같은 주문이 두 번 발송·차감된다.
    const openOverlap = hasKeys ? await findOpenOverlap(sb, sig, new Set(matchKeys)) : null;

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
      messageWarnings: res.messageWarnings, // 배송메시지 확인 목록 — 빠뜨리면 화면 카드가 영영 안 뜬다
      unmatched: res.unmatched,
      outbound: res.outbound, // SKU별 출고수량(재고 출고 연동용) — PII 없음
      sig, // 배치 서명(batchSig) — 4단계 출고가 이 값을 그대로 써야 대기 키·중복 검사가 이 파일과 정확히 이어진다
      hasKeys,                                    // 대기 키 저장됨 — ④ 출고가 expectKeys 로 그대로 전달(없으면 처리완료 표시 불가로 멈춤)
      dedupEnabled: dedup.enabled && !dedupSkipped, // false 면 화면에 '중복 방지 꺼짐' 경고
      openOverlap,                                // CN 받은 미출고 배치와 겹치는 주문
      excludedProcessed,                          // 이미 출고 처리돼 자동 제외한 주문 수
      excludedOrderNos: excludedOrderNos.slice(0, 10), // 표시용 일부
      interruptedResume, interruptedExcluded,       // 중단된 출고(재고 미차감) — 이어서 차감 / 그 주문을 뺌
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
