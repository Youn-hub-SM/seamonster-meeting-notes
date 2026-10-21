import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getInventoryRows } from "@/app/lib/production-inventory";
import { createProductionRequest, defaultDueDate, defaultProdStart, kstTodayIso, CreateError, type CreateItem } from "@/app/lib/production-request-create";
import { logProductionDraftNotice } from "@/app/lib/b2b-activity";
import { getFeatureModel, effortParams, readText } from "@/app/lib/ai-model";
import { getKv } from "@/app/lib/b2b-settings";
import { getAllBundles } from "@/app/lib/product-bundles";
import { DRAFT_WEEKDAY } from "@/app/lib/production-schedule";
import { getDraftSchedule, getDraftDone, setDraftDone, setDraftLastRun, DRAFT_TICK_WINDOW_MIN } from "@/app/lib/production-draft-schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 주간 생산 요청서 AI 초안 — 매주 수요일, 작성 시각·켜기는 관리자 › 설정 › 생산·재고(production_draft_schedule, 2026-10-21).
//  주 실행 = Supabase pg_cron 이 수요일(KST)에 5분마다 {tick:true} 로 노크(migration 147, DIGEST_CRON_KEY) — 작성 시각 ~ +15분 창에서만 만든다.
//  예비 = 릴레이 crontab `50 4 * * 3`(수 13:50) production-draft.sh — 꺼져 있거나 작성 시각 전이면 건너뛴다.
//  date 를 직접 넘기거나 force:true 면(관리자 재실행) 설정과 무관하게 만든다.
//  재고 목록 권장(소매 수식 + 도매 필요량 − 입고 예정)으로 제조사(재고 보충) 요청서를 '요청' 상태로 만들고,
//  팀즈에 게시한다. 생산담당자가 화면에서 수량을 고친 뒤 결재자에게 보고하는 초안이다.
//  일정(영업일): 작성 D → 컨펌·제출 D+1 → 생산 시작 D+3 → 생산 마감 D+7 → 판매 가능 D+8.
//  미들웨어 예외 경로 — Bearer(카탈로그 업로드 공용 시크릿 또는 CRON_SECRET)로 인증. 같은 날 두 번 불려도 한 장만 만든다.
const DRAFT_AUTHOR = "AI 초안";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bearerOk(req: NextRequest): boolean {
  const authz = req.headers.get("authorization") || "";
  const keys = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET, process.env.DIGEST_CRON_KEY]; // DIGEST_CRON_KEY = pg_cron 틱(147)
  return keys.some((k) => k && k.trim() && authz === `Bearer ${k.trim()}`);
}

type DraftLine = { sku: string; name: string; product_id: string; qty: number; stock: number | null; inbound: number; wholeRec: number; demand: number; safety: number; dailyOut: number };

// Claude 검토 메모(선택) — 수량은 수식이 정하고, AI 는 담당자가 볼 검토 포인트만 3~5줄 적는다.
//  b2b_settings 'production_draft_ai_note' = off 면 건너뛴다(주 1회 호출이라 비용은 작다). 실패해도 초안은 만든다.
async function aiReviewNote(lines: DraftLine[], zeroButLow: DraftLine[], horizonDays: number, nextDraft: string, nextSellable: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return "";
  if ((await getKv("production_draft_ai_note")).toLowerCase() === "off") return "";
  const model = await getFeatureModel("production");
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 0 }); // 라우트 60초 안(재고 집계 시간 포함)
  const payload = {
    목표일수: horizonDays, // 오늘 → 다음 요청분 판매 가능일
    다음요청일: nextDraft,
    다음요청분판매가능일: nextSellable,
    초안품목: lines.slice(0, 40).map((l) => ({ sku: l.sku, name: l.name, 요청수량: l.qty, 현재고: l.stock, 입고예정: l.inbound, 도매필요량: l.wholeRec, B2B수요: l.demand, 목표재고: l.safety, 일평균출고: Math.round(l.dailyOut * 10) / 10 })),
    권장0이지만재고적은품목: zeroButLow.slice(0, 15).map((l) => ({ sku: l.sku, name: l.name, 현재고: l.stock, 입고예정: l.inbound, 목표재고: l.safety })),
  };
  const system = `당신은 씨몬스터(냉동 수산물 가공) 생산계획 검토자입니다. 주간 제조사 생산 요청서 초안(수량은 수식이 이미 정함)을 생산담당자가 확인하기 전에 검토 포인트를 적습니다.
규칙: 한국어 존댓말, 3~5줄, 각 줄은 '- '로 시작, 한 줄 = 한 가지 확인 사항. 수량을 새로 제안하지 말고, 이상치(재고 대비 과다·과소, 입고 예정이 큰데 또 시키는 품목 등)만 짚습니다. 데이터에 없는 것은 쓰지 않습니다. 설명·머리말 없이 줄만 출력합니다.`;
  try {
    // 3~5줄 메모지만 5.x 는 생각 토큰도 max_tokens 에 들어간다 — 600 이면 거의 확실히 잘린다
    const res = await anthropic.messages.create({ model, max_tokens: 2000, system, messages: [{ role: "user", content: JSON.stringify(payload) }], ...effortParams(model, "low") });
    const text = readText(res).trim();
    return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith("- ")).slice(0, 6).join("\n");
  } catch (e) {
    console.error("[production/requests/draft] AI 검토 메모 실패", e);
    return "";
  }
}

// POST { date?: YYYY-MM-DD, dry?: boolean, tick?: boolean, force?: boolean } — 초안 생성. dry=true 면 만들지 않고 계산 결과만 돌려준다(점검용).
export async function POST(req: NextRequest) {
  if (!bearerOk(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* body 없음 */ }
  const explicitDate = DATE_RE.test(String(body.date || ""));
  const D = explicitDate ? String(body.date) : kstTodayIso();
  const dry = body.dry === true;
  const tick = body.tick === true;
  // 예약 확인 — 관리자 재실행(date·force)·점검(dry)이 아니면 설정을 따른다
  const sched = await getDraftSchedule();
  const kst = new Date(Date.now() + 9 * 3600_000);
  const nowMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const [th, tm] = sched.time.split(":").map(Number);
  const since = nowMin - (th * 60 + tm); // 작성 시각부터 지난 분
  let lastTry = true; // 실패 알림은 마지막 시도에서만(틱 창 안의 앞 시도는 조용히 — 5분마다 실패 알림이 쌓이지 않게)
  if (!explicitDate && !dry && body.force !== true) {
    if (!sched.enabled) return NextResponse.json({ ok: true, created: false, skipped: "disabled" });
    if (tick) {
      if (kst.getUTCDay() !== DRAFT_WEEKDAY || since < 0 || since >= DRAFT_TICK_WINDOW_MIN) return NextResponse.json({ ok: true, created: false, skipped: "not-due" });
      lastTry = since >= DRAFT_TICK_WINDOW_MIN - 5;
    } else if (kst.getUTCDay() === DRAFT_WEEKDAY && since < 0) {
      return NextResponse.json({ ok: true, created: false, skipped: `before-${sched.time}` }); // 예비 릴레이가 작성 시각보다 먼저 온 경우
    }
    if ((await getDraftDone()) === D) return NextResponse.json({ ok: true, created: false, skipped: "already-done" });
  }
  const runAt = `${D} ${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`;
  const finish = async (result: string) => { if (!dry) { try { await setDraftDone(D); } catch { /* 다음 호출의 중복 방지는 아래 초안 조회가 한 번 더 막는다 */ } await setDraftLastRun(`${runAt} · ${result}`); } };
  try {
    const sb = supabaseAdmin();

    // 같은 날 초안이 이미 있으면(크론 재시도·중복 호출) 그대로 돌려준다 — 취소된 초안은 다시 만들 수 있다.
    //  키 = 작성자(created_by, 화면에서 못 바꿈) + (요청일 = D 또는 작성 시각이 D 하루 안). 요청일·요청자는 검토자가 수정 창에서
    //  바꿀 수 있어 요청일만으로 찾으면 재시도에 두 번째 초안이 생긴다.
    const nextDay = new Date(Date.parse(`${D}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);
    const { data: dup, error: de } = await sb.from("production_requests").select("id, req_no, status")
      .eq("created_by", DRAFT_AUTHOR).neq("status", "취소")
      .or(`request_date.eq.${D},and(created_at.gte.${D}T00:00:00+09:00,created_at.lt.${nextDay}T00:00:00+09:00)`).limit(1);
    if (de) throw de;
    if (!dry && dup && dup.length) { await finish(`이미 있음 ${dup[0].req_no || ""}`.trim()); return NextResponse.json({ ok: true, created: false, existing: dup[0] }); }

    const [retail, whole] = await Promise.all([getInventoryRows("소매"), getInventoryRows("도매")]);
    // 집계 실패 = 초안을 만들지 않는다(S4) — 입고 예정을 못 빼면 이미 시켜 둔 물량을 또 시키고('요청' 초안은 곧바로
    //  다른 화면의 입고 예정에 들어가 권장을 깎는다), 행사 일정·보정·세트·재고 관리 안 함을 못 읽으면 수량이 틀린다.
    //  메모 한 줄 경고는 검토자가 놓친다. 만들지 않았으니 재실행은 안전하다(같은 날 중복 방지는 그대로).
    const aggFail: string[] = [];
    if (!retail.inboundOk) aggFail.push("입고 예정(열린 요청서 잔여)");
    if (!retail.settingsOk) aggFail.push("행사 일정·안전재고 보정");
    {
      // 재고 관리 사용 안함(121) — getInventoryRows 가 getUntracked 조회 오류를 던지므로(위 집계에서 멈춤) 이 확인은 중복이다.
      //  해는 없어 남겨 둔다(컬럼 없음 = 121 미적용만 통과).
      const { error: ue } = await sb.from("products").select("id", { count: "exact", head: true }).eq("stock_tracked", false);
      if (ue && !/stock_tracked/i.test(ue.message)) aggFail.push("재고 관리 사용 안함 품목");
    }
    const retailBySku = new Map(retail.rows.map((r) => [r.sku.toUpperCase(), r]));
    const wholeBySku = new Map(whole.rows.map((r) => [r.sku.toUpperCase(), r]));

    // 권장 = max(0, ①소매 원값 + ②도매 필요량 − ⑤입고 예정) — 재고 목록 전체 탭·새 요청 창과 같은 합산식(합계에서 ⑤를 한 번만 뺀다).
    //  품목은 소매·도매 행의 합집합 — 소매 원장이 없는 도매 전용 품목도 화면처럼 도매 필요량으로 들어간다(최종 점검 확정).
    const cands: DraftLine[] = [];
    const zeroButLow: DraftLine[] = [];
    for (const sku of new Set([...retailBySku.keys(), ...wholeBySku.keys()])) {
      const r = retailBySku.get(sku);
      const w = wholeBySku.get(sku);
      const gross = r ? (r.stock == null ? r.demand : Math.max(0, r.demand + r.safety - r.stock)) : 0;
      const wholeRec = Number(w?.recommend) || 0;
      const inbound = r?.inbound ?? 0;
      const rec = Math.max(0, Math.round((gross + wholeRec - inbound) * 100) / 100);
      const base = (r ?? w)!;
      const line: DraftLine = { sku: base.sku, name: base.name, product_id: "", qty: Math.ceil(rec), stock: r?.stock ?? null, inbound, wholeRec, demand: r?.demand ?? 0, safety: r?.safety ?? 0, dailyOut: r?.dailyOut ?? 0 };
      if (line.qty > 0) cands.push(line);
      else if (r?.belowSafety) zeroButLow.push(line);
    }

    // SKU → product_id (요청서 품목은 product_id 기준). 묶음(세트)은 자체 재고가 없어 제외.
    //  재고 행의 SKU 는 대문자로 정규화돼 오고 products.sku 는 입력 그대로라 DB 의 .in() 은 대소문자가 다르면 못 찾는다 —
    //  제품표 전량을 읽어 대문자 키로 맞춘다(다른 화면들과 같은 대소문자 무시 규칙).
    //  사용 중(active) 품목만 — 재고 목록·요청 창이 보여 주는 품목과 같게. 미사용 품목은 초안에서 빼고 메모에 적는다.
    const pidBySku = new Map<string, string>();
    const inactiveSkus = new Set<string>();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await sb.from("products").select("id, sku, active").order("id", { ascending: true }).range(off, off + 999);
      if (error) throw error;
      for (const p of (data ?? []) as { id: string; sku: string | null; active: boolean | null }[]) {
        if (!p.sku) continue;
        const k = String(p.sku).trim().toUpperCase();
        if (p.active === false) inactiveSkus.add(k);
        else pidBySku.set(k, p.id);
      }
      if ((data ?? []).length < 1000) break;
    }
    // 세트 — 조회 오류는 던진다(getAllBundles, S4). '세트 없음'으로 보면 세트가 초안에 담긴다.
    const bundleIds = new Set<string>((await getAllBundles(sb)).keys());
    const lines: DraftLine[] = [];
    const unmatched: string[] = [];
    const inactive: string[] = [];
    for (const c of cands) {
      const pid = pidBySku.get(c.sku.toUpperCase());
      if (!pid) { if (inactiveSkus.has(c.sku.toUpperCase())) inactive.push(c.sku); else unmatched.push(c.sku); continue; }
      if (bundleIds.has(pid)) continue;
      lines.push({ ...c, product_id: pid });
    }
    lines.sort((a, b) => b.qty - a.qty || a.sku.localeCompare(b.sku));

    const prodStart = defaultProdStart(D);
    const dueDate = defaultDueDate("재고 보충", D) || prodStart;
    const memoLines = [
      `AI 초안(매주 수요일 ${sched.time} 자동 작성) — 생산담당자가 확인·수정한 뒤 결재자에게 보고합니다.`,
      `근거: 재고 목록 권장(소매 수식 + 도매 필요량 − 입고 예정), 작성 ${D} / 생산 시작 ${prodStart} / 생산 마감 ${dueDate} (영업일 D+3 / D+7).`,
      // 수량은 지금 재고로 계산하므로 목표 일수도 계산일(오늘 KST) 기준 — D 를 따로 넘긴 재실행이면 계산일을 함께 적는다
      `목표: 평상시 하루 출고 × ${retail.horizonDays}일${retail.schedule.today !== D ? ` (계산일 ${retail.schedule.today} 기준)` : ""} — 이번 요청분 판매 가능 ${retail.schedule.sellable}, 다음 요청분(${retail.schedule.nextDraft}) 판매 가능 ${retail.schedule.nextSellable}까지 버틸 양.`,
    ];
    if (unmatched.length) memoLines.push(`품목표에 없어 뺀 SKU: ${unmatched.slice(0, 10).join(", ")}${unmatched.length > 10 ? ` 외 ${unmatched.length - 10}` : ""}`);
    if (inactive.length) memoLines.push(`미사용 품목이라 뺀 SKU: ${inactive.slice(0, 10).join(", ")}${inactive.length > 10 ? ` 외 ${inactive.length - 10}` : ""}`);

    if (aggFail.length) {
      const total = lines.reduce((a, l) => a + l.qty, 0);
      const detail = [
        `집계 실패: ${aggFail.join(", ")} — 이 상태로 만들면 수량이 틀려 초안을 만들지 않았습니다. 관리자에게 초안 재실행을 요청하거나 '+ 새 생산 요청'으로 직접 만드세요.`,
        `참고(검토 안 된 계산값): ${lines.length}품목 · ${total.toLocaleString()}개`,
        ...lines.slice(0, 15).map((l) => `- ${l.name} ×${l.qty.toLocaleString()}`),
        ...(lines.length > 15 ? [`- 외 ${lines.length - 15}품목`] : []),
      ].join("\n");
      if (dry) return NextResponse.json({ ok: true, created: false, dry: true, date: D, agg_failed: aggFail, lines, unmatched });
      if (lastTry) await logProductionDraftNotice(`생산요청 AI 초안 ${D} — 집계 실패, 초안 미작성(재실행 필요)`, detail);
      await setDraftLastRun(`${runAt} · 집계 실패${lastTry ? "" : "(다음 틱에 다시 시도)"}`);
      return NextResponse.json({ ok: false, created: false, error: `집계 실패(${aggFail.join(", ")}) — 초안을 만들지 않았습니다. 다시 실행하세요.`, agg_failed: aggFail, date: D }, { status: 503 });
    }

    if (!lines.length) {
      const detail = memoLines.join("\n");
      if (!dry) { await logProductionDraftNotice(`생산요청 AI 초안 ${D} — 권장 0, 초안을 만들지 않았습니다`, detail); await finish("권장 0, 초안 없음"); }
      return NextResponse.json({ ok: true, created: false, reason: "권장 0", date: D, unmatched });
    }

    const note = await aiReviewNote(lines, zeroButLow, retail.horizonDays, retail.schedule.nextDraft, retail.schedule.nextSellable);
    if (note) memoLines.push(`AI 검토 포인트:`, note);
    const memo = memoLines.join("\n");
    const items: CreateItem[] = lines.map((l) => ({ product_id: l.product_id, requested_qty: l.qty, memo: null }));

    if (dry) return NextResponse.json({ ok: true, created: false, dry: true, date: D, prod_start: prodStart, due_date: dueDate, memo, lines, unmatched });

    const { request: full, existing } = await createProductionRequest(sb, {
      title: `AI 초안 ${D}`,
      requested_by: DRAFT_AUTHOR,
      request_date: D,
      prod_start: prodStart,
      due_date: dueDate,
      purpose: "재고 보충",
      memo,
      items,
      status: "요청",
      created_by: DRAFT_AUTHOR,
      client_key: `ai-draft-${D}`, // 136 — 동시에 두 번 불려도 한 장(위 중복 확인은 조회 후 삽입이라 경합을 못 막는다). 취소하면 키를 비운다
    });
    await finish(existing ? `이미 있음 ${full.req_no || ""}`.trim() : `작성 ${full.req_no || ""} · ${full.items.length}품목`);
    if (existing) return NextResponse.json({ ok: true, created: false, existing: { id: full.id, req_no: full.req_no, status: full.status } });
    return NextResponse.json({ ok: true, created: true, request: { id: full.id, req_no: full.req_no, items: full.items.length, total: full.total_requested }, date: D, unmatched });
  } catch (err) {
    console.error("[production/requests/draft POST]", err);
    const msg = err instanceof CreateError ? err.message : extractErrorMsg(err, "초안 생성 실패");
    // 실패도 팀즈로 알린다 — 수요일 14시에 아무것도 안 오면 담당자는 '이번 주는 권장이 없나'로 오해한다
    if (!dry) {
      if (lastTry) { try { await logProductionDraftNotice(`생산요청 AI 초안 ${D} — 생성 실패: ${msg}`, "'+ 새 생산 요청'으로 직접 만들거나, 관리자에게 초안 재실행을 요청하세요."); } catch { /* 알림 실패 무시 */ } }
      await setDraftLastRun(`${runAt} · 실패: ${msg.slice(0, 80)}${lastTry ? "" : "(다음 틱에 다시 시도)"}`);
    }
    return NextResponse.json({ ok: false, error: msg }, { status: err instanceof CreateError ? err.status : 500 });
  }
}
