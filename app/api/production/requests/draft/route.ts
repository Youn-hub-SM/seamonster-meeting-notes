import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getInventoryRows } from "@/app/lib/production-inventory";
import { createProductionRequest, defaultDueDate, defaultProdStart, kstTodayIso, CreateError, type CreateItem } from "@/app/lib/production-request-create";
import { logProductionDraftNotice } from "@/app/lib/b2b-activity";
import { getFeatureModel } from "@/app/lib/ai-model";
import { getKv } from "@/app/lib/b2b-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 주간 생산 요청서 AI 초안 — 매주 수요일 13:50 KST(릴레이 crontab `50 4 * * 3`, 14시 전 게시) production-draft.sh 가 운영을 호출한다.
//  재고 목록 권장(소매 수식 + 도매 필요량 − 입고 예정)으로 제조사(재고 보충) 요청서를 '요청' 상태로 만들고,
//  팀즈에 게시한다. 생산담당자가 화면에서 수량을 고친 뒤 결재자에게 보고하는 초안이다.
//  일정(영업일): 작성 D → 컨펌·제출 D+1 → 생산 시작 D+5 → 생산 마감 D+9 → 판매 가능 D+10.
//  미들웨어 예외 경로 — Bearer(카탈로그 업로드 공용 시크릿 또는 CRON_SECRET)로 인증. 같은 날 두 번 불려도 한 장만 만든다.
const DRAFT_AUTHOR = "AI 초안";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bearerOk(req: NextRequest): boolean {
  const authz = req.headers.get("authorization") || "";
  const keys = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET];
  return keys.some((k) => k && k.trim() && authz === `Bearer ${k.trim()}`);
}

type DraftLine = { sku: string; name: string; product_id: string; qty: number; stock: number | null; inbound: number; wholeRec: number; demand: number; safety: number; dailyOut: number };

// Claude 검토 메모(선택) — 수량은 수식이 정하고, AI 는 담당자가 볼 검토 포인트만 3~5줄 적는다.
//  b2b_settings 'production_draft_ai_note' = off 면 건너뛴다(주 1회 호출이라 비용은 작다). 실패해도 초안은 만든다.
async function aiReviewNote(lines: DraftLine[], zeroButLow: DraftLine[], horizonDays: number): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return "";
  if ((await getKv("production_draft_ai_note")).toLowerCase() === "off") return "";
  const model = await getFeatureModel("production");
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 25_000, maxRetries: 0 });
  const payload = {
    안전재고지평일수: horizonDays,
    초안품목: lines.slice(0, 40).map((l) => ({ sku: l.sku, name: l.name, 요청수량: l.qty, 현재고: l.stock, 입고예정: l.inbound, 도매필요량: l.wholeRec, B2B수요: l.demand, 목표재고: l.safety, 일평균출고: Math.round(l.dailyOut * 10) / 10 })),
    권장0이지만재고적은품목: zeroButLow.slice(0, 15).map((l) => ({ sku: l.sku, name: l.name, 현재고: l.stock, 입고예정: l.inbound, 목표재고: l.safety })),
  };
  const system = `당신은 씨몬스터(냉동 수산물 가공) 생산계획 검토자입니다. 주간 제조사 생산 요청서 초안(수량은 수식이 이미 정함)을 생산담당자가 확인하기 전에 검토 포인트를 적습니다.
규칙: 한국어 존댓말, 3~5줄, 각 줄은 '- '로 시작, 한 줄 = 한 가지 확인 사항. 수량을 새로 제안하지 말고, 이상치(재고 대비 과다·과소, 입고 예정이 큰데 또 시키는 품목 등)만 짚습니다. 데이터에 없는 것은 쓰지 않습니다. 설명·머리말 없이 줄만 출력합니다.`;
  try {
    const res = await anthropic.messages.create({ model, max_tokens: 600, system, messages: [{ role: "user", content: JSON.stringify(payload) }] });
    const text = res.content[0]?.type === "text" ? res.content[0].text.trim() : "";
    return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith("- ")).slice(0, 6).join("\n");
  } catch (e) {
    console.error("[production/requests/draft] AI 검토 메모 실패", e);
    return "";
  }
}

// POST { date?: YYYY-MM-DD, dry?: boolean } — 초안 생성. dry=true 면 만들지 않고 계산 결과만 돌려준다(점검용).
export async function POST(req: NextRequest) {
  if (!bearerOk(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* body 없음 */ }
  const D = DATE_RE.test(String(body.date || "")) ? String(body.date) : kstTodayIso();
  const dry = body.dry === true;
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
    if (!dry && dup && dup.length) return NextResponse.json({ ok: true, created: false, existing: dup[0] });

    const [retail, whole] = await Promise.all([getInventoryRows("소매"), getInventoryRows("도매")]);
    const wholeBySku = new Map(whole.rows.map((r) => [r.sku.toUpperCase(), Number(r.recommend) || 0]));

    // 권장 = max(0, ①소매 원값 + ②도매 필요량 − ⑤입고 예정) — 재고 목록·새 요청 창과 같은 합산식(합계에서 ⑤를 한 번만 뺀다).
    const cands: DraftLine[] = [];
    const zeroButLow: DraftLine[] = [];
    for (const r of retail.rows) {
      const sku = r.sku.toUpperCase();
      const gross = r.stock == null ? r.demand : Math.max(0, r.demand + r.safety - r.stock);
      const wholeRec = wholeBySku.get(sku) ?? 0;
      const rec = Math.max(0, Math.round((gross + wholeRec - r.inbound) * 100) / 100);
      const line: DraftLine = { sku: r.sku, name: r.name, product_id: "", qty: Math.ceil(rec), stock: r.stock, inbound: r.inbound, wholeRec, demand: r.demand, safety: r.safety, dailyOut: r.dailyOut };
      if (line.qty > 0) cands.push(line);
      else if (r.belowSafety) zeroButLow.push(line);
    }

    // SKU → product_id (요청서 품목은 product_id 기준). 묶음(세트)은 자체 재고가 없어 제외.
    //  재고 행의 SKU 는 대문자로 정규화돼 오고 products.sku 는 입력 그대로라 DB 의 .in() 은 대소문자가 다르면 못 찾는다 —
    //  제품표 전량을 읽어 대문자 키로 맞춘다(다른 화면들과 같은 대소문자 무시 규칙).
    const pidBySku = new Map<string, string>();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await sb.from("products").select("id, sku").order("id", { ascending: true }).range(off, off + 999);
      if (error) throw error;
      for (const p of (data ?? []) as { id: string; sku: string | null }[]) if (p.sku) pidBySku.set(String(p.sku).trim().toUpperCase(), p.id);
      if ((data ?? []).length < 1000) break;
    }
    const bundleIds = new Set<string>();
    const pids = [...new Set([...pidBySku.values()])];
    for (let i = 0; i < pids.length; i += 100) {
      const { data, error } = await sb.from("product_bundles").select("parent_id").in("parent_id", pids.slice(i, i + 100));
      if (!error) for (const b of (data ?? []) as { parent_id: string }[]) bundleIds.add(b.parent_id);
    }
    const lines: DraftLine[] = [];
    const unmatched: string[] = [];
    for (const c of cands) {
      const pid = pidBySku.get(c.sku.toUpperCase());
      if (!pid) { unmatched.push(c.sku); continue; }
      if (bundleIds.has(pid)) continue;
      lines.push({ ...c, product_id: pid });
    }
    lines.sort((a, b) => b.qty - a.qty || a.sku.localeCompare(b.sku));

    const prodStart = defaultProdStart(D);
    const dueDate = defaultDueDate("재고 보충", D) || prodStart;
    const memoLines = [
      `AI 초안(매주 수요일 14시 자동 작성) — 생산담당자가 확인·수정한 뒤 결재자에게 보고합니다.`,
      `근거: 재고 목록 권장(소매 수식 + 도매 필요량 − 입고 예정), 작성 ${D} / 생산 시작 ${prodStart} / 생산 마감 ${dueDate} (영업일 D+5 / D+9).`,
    ];
    if (!retail.inboundOk) memoLines.push(`주의: 입고 예정(열린 요청서 잔여) 집계에 실패해 이미 시켜 둔 물량을 빼지 못했습니다 — 열린 제조사 요청서와 겹치는지 확인하세요.`);
    if (unmatched.length) memoLines.push(`품목표에 없어 뺀 SKU: ${unmatched.slice(0, 10).join(", ")}${unmatched.length > 10 ? ` 외 ${unmatched.length - 10}` : ""}`);

    if (!lines.length) {
      const detail = memoLines.join("\n");
      if (!dry) await logProductionDraftNotice(`생산요청 AI 초안 ${D} — 권장 0, 초안을 만들지 않았습니다`, detail);
      return NextResponse.json({ ok: true, created: false, reason: "권장 0", date: D, unmatched });
    }

    const note = await aiReviewNote(lines, zeroButLow, retail.horizonDays);
    if (note) memoLines.push(`AI 검토 포인트:`, note);
    const memo = memoLines.join("\n");
    const items: CreateItem[] = lines.map((l) => ({ product_id: l.product_id, requested_qty: l.qty, memo: null }));

    if (dry) return NextResponse.json({ ok: true, created: false, dry: true, date: D, prod_start: prodStart, due_date: dueDate, memo, lines, unmatched });

    const full = await createProductionRequest(sb, {
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
    });
    return NextResponse.json({ ok: true, created: true, request: { id: full.id, req_no: full.req_no, items: full.items.length, total: full.total_requested }, date: D, unmatched });
  } catch (err) {
    console.error("[production/requests/draft POST]", err);
    const msg = err instanceof CreateError ? err.message : extractErrorMsg(err, "초안 생성 실패");
    // 실패도 팀즈로 알린다 — 수요일 14시에 아무것도 안 오면 담당자는 '이번 주는 권장이 없나'로 오해한다
    if (!dry) { try { await logProductionDraftNotice(`생산요청 AI 초안 ${D} — 생성 실패: ${msg}`, "'+ 새 생산 요청'으로 직접 만들거나, 관리자에게 초안 재실행을 요청하세요."); } catch { /* 알림 실패 무시 */ } }
    return NextResponse.json({ ok: false, error: msg }, { status: err instanceof CreateError ? err.status : 500 });
  }
}
