import type { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "./supabase";
import { getFeatureModel } from "./ai-model";
import { getKv } from "./b2b-settings";
import { sendTeamsWebhook } from "./b2b-teams";
import { CHANGELOG } from "./changelog";

// 대표 전용 아침 브리핑 (2026-09-02, migration 103) — 업무도우미 전 영역의 '어제'를 집계해
//  변화 + AI 인사이트를 만든다. 생성 = pg_cron(06:30 KST, 운영) 또는 /briefing 화면의 수동 버튼.
//  원칙: AI 는 여기서 집계한 숫자만 인용한다. 증감률·평균 대비 판단까지 코드가 계산해 넣는다
//  (LLM 암산·임의 카운트로 틀리는 사고 방지 — VOC 리포트 교훈).

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const kstDate = (back = 0) => {
  const d = new Date(Date.now() + 9 * 3600e3);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
};
const shiftDate = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
// KST 하루의 UTC 경계 [start, end) — timestamptz 컬럼(activity_log 등) 집계용
const kstDayUtc = (ymd: string) => {
  const start = new Date(`${ymd}T00:00:00+09:00`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86400e3).toISOString() };
};

// 서버 Max Rows 캡(기본 1000) 대비 range 페이징. 호출부는 안정 정렬(.order("id"))을 반드시 건다 —
//  정렬 없는 range 는 페이지 사이 동시 insert 에 행이 누락/중복될 수 있다.
async function pagedRows<T>(build: () => { range: (a: number, b: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> }, maxRows = 20000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < maxRows; i += 1000) {
    const { data, error } = await build().range(i, Math.min(i + 999, maxRows - 1));
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ── 영역별 집계 — 각 블록은 실패해도(테이블 미적용 등) null 로 두고 브리핑은 계속 만든다 ──
export async function collectBriefingData(sb: SupabaseClient, briefDate: string) {
  const yst = shiftDate(briefDate, -1);
  // 비교 기준선 = 어제를 뺀 직전 7일(briefDate-8 ~ briefDate-2) — 어제가 평균을 끌고 가지 않게
  const weekFrom = shiftDate(briefDate, -8);
  const weekTo = shiftDate(briefDate, -2);
  const in2days = shiftDate(briefDate, 2); // 마감 3일내 = 오늘 포함 3일

  // 매출(소매) — 어제 합계 + 기준선 일평균(집계는 DB RPC, 절단 없음) + 증감률(코드 계산)
  const sales = await (async () => {
    try {
      const rows = await pagedRows<{ subtotal_amount: number; quantity: number }>(
        () => sb.from("sales_orders").select("subtotal_amount, quantity").eq("order_date", yst).order("id", { ascending: true }));
      const { data: wk, error: we } = await sb.rpc("sales_summary", { p_from: weekFrom, p_to: weekTo });
      if (we) throw new Error(we.message);
      const weekRevenue = Number((Array.isArray(wk) ? wk[0] : wk)?.revenue) || 0;
      const avg = Math.round(weekRevenue / 7);
      const total = rows.reduce((s, r) => s + (Number(r.subtotal_amount) || 0), 0);
      return {
        어제_매출액: total,
        어제_판매행수: rows.length,
        어제_판매수량: rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0),
        기준선_일평균_매출액_직전7일_어제제외: avg,
        어제_기준선대비_증감률_퍼센트: avg > 0 ? Math.round(((total - avg) / avg) * 100) : null,
      };
    } catch { return null; }
  })();

  // B2B 발주 — 어제 등록 발주 + 오늘 발송 예정/지연
  const b2b = await (async () => {
    try {
      const ords = await pagedRows<{ total: number }>(
        () => sb.from("orders").select("total").eq("order_date", yst).order("id", { ascending: true }), 5000);
      const { count: shipToday } = await sb.from("shipments").select("id", { count: "exact", head: true }).eq("ship_date", briefDate).eq("status", "발송대기");
      const { count: shipLate } = await sb.from("shipments").select("id", { count: "exact", head: true }).lt("ship_date", briefDate).eq("status", "발송대기");
      return {
        어제_신규발주: ords.length,
        어제_신규발주_금액: ords.reduce((s, r) => s + (Number(r.total) || 0), 0),
        오늘_발송예정: shipToday ?? 0,
        발송_지연: shipLate ?? 0,
      };
    } catch { return null; }
  })();

  // 재고 — 어제 입출고(완료만), 대기 입고
  const inventory = await (async () => {
    try {
      const rows = await pagedRows<{ type: string; qty: number; status?: string | null }>(
        () => sb.from("inventory_txns").select("type, qty, status").eq("txn_date", yst).order("id", { ascending: true }), 10000);
      const done = rows.filter((r) => r.status !== "대기");
      const sum = (t: string) => done.filter((r) => r.type === t).reduce((s, r) => s + Math.abs(Number(r.qty) || 0), 0);
      const { count: pendIn } = await sb.from("inventory_txns").select("id", { count: "exact", head: true }).eq("type", "입고").eq("status", "대기");
      return { 어제_입고수량: sum("입고"), 어제_출고수량: sum("출고"), 어제_조정건수: done.filter((r) => r.type === "조정").length, 대기중_입고건수: pendIn ?? 0 };
    } catch { return null; }
  })();

  // 생산 — 열린 요청, 마감 임박·지연
  const production = await (async () => {
    try {
      const { data } = await sb.from("production_requests").select("due_date, status").in("status", ["요청", "진행중"]).limit(500);
      const rows = data ?? [];
      return {
        열린_생산요청: rows.length,
        마감_지연: rows.filter((r) => r.due_date && String(r.due_date) < briefDate).length,
        마감_3일내: rows.filter((r) => r.due_date && String(r.due_date) >= briefDate && String(r.due_date) <= in2days).length,
      };
    } catch { return null; }
  })();

  // VOC — 어제 신규(카테고리별) + 기준선 일평균.
  //  ※ 건별 status 는 029 이후 '접수/응대·개선중/개선완료' 인데 072 이후 건별 상태 UI 가 없어
  //    '미처리 잔량'은 신뢰할 수 없는 지표다 — 세지 않는다(신규량 추세만 본다).
  const voc = await (async () => {
    try {
      const { data } = await sb.from("voc").select("category").eq("received_at", yst).limit(1000);
      const byCat: Record<string, number> = {};
      for (const r of data ?? []) byCat[(r.category as string) || "기타"] = (byCat[(r.category as string) || "기타"] || 0) + 1;
      const { count: wkCnt } = await sb.from("voc").select("id", { count: "exact", head: true }).gte("received_at", weekFrom).lte("received_at", weekTo);
      return {
        어제_신규VOC: (data ?? []).length,
        어제_카테고리별: byCat,
        기준선_일평균_신규VOC_직전7일_어제제외: Math.round(((wkCnt ?? 0) / 7) * 10) / 10,
      };
    } catch { return null; }
  })();

  // 팀 활동 — 어제 변경기록 수·상위 이벤트 (전 영역 피드라 대량일 수 있어 페이징)
  const activity = await (async () => {
    try {
      const { start, end } = kstDayUtc(yst);
      const rows = await pagedRows<{ event_type: string }>(
        () => sb.from("activity_log").select("event_type").gte("created_at", start).lt("created_at", end).order("id", { ascending: true }), 10000);
      const byType: Record<string, number> = {};
      for (const r of rows) byType[r.event_type || "기타"] = (byType[r.event_type || "기타"] || 0) + 1;
      const top = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 5);
      return { 어제_활동건수: rows.length, 상위_활동: Object.fromEntries(top) };
    } catch { return null; }
  })();

  // 전일 브리핑의 집계 — '전일 대비' 판단의 근거(없으면 null)
  const prev = await (async () => {
    try {
      const { data } = await sb.from("briefings").select("data").eq("brief_date", yst).maybeSingle();
      return (data?.data as Record<string, unknown>) ?? null;
    } catch { return null; }
  })();

  // 도구 변경 — 어제 이후 업데이트 노트(정적 changelog)
  const toolChanges = CHANGELOG.filter((c) => c.date >= yst).slice(0, 6)
    .map((c) => ({ 날짜: c.date, 구분: c.tag, 도구: c.tool, 제목: c.title }));

  return { 기준일_어제: yst, 매출: sales, 발주와발송: b2b, 재고: inventory, 생산: production, VOC: voc, 팀활동: activity, 전일_브리핑_집계: prev, 도구변경: toolChanges };
}

const SYSTEM = `당신은 씨몬스터(수산물 이커머스) 대표의 아침 브리핑 비서다. 내부 업무도구가 집계한 '어제'의 숫자(JSON)를 받아, 대표가 1분 안에 읽을 브리핑을 한국어로 쓴다.

규칙:
- 반드시 제공된 집계 숫자만 인용한다. 목록을 임의로 세거나 제공되지 않은 숫자를 만들지 않는다.
- 증감률·평균 대비 표현은 집계에 '증감률'/'기준선' 필드가 있는 항목에서만, 그 값을 그대로 인용한다. 직접 계산·암산 금지.
- '평소보다 많다/급증' 류의 상대 판단은 기준선 필드나 전일_브리핑_집계로 뒷받침될 때만 쓴다. 근거 없으면 절대값만 서술.
- 값이 null 인 영역은 언급하지 않는다. 이모지 금지. 간결한 존댓말. 금액은 천 단위 콤마 + '원'.
- 출력은 마크다운만: "## 제목" 섹션, "- 라벨 : 내용" 불릿.

골격(순서 고정):
## 핵심 3줄
- 어제의 가장 중요한 변화 3개(매출 증감·지연·이상 신호 우선)
## 영역별 변화
- 매출 : 어제 매출, 기준선(직전 7일 일평균) 대비 증감률
- 발주·발송 : 신규 발주, 오늘 발송 예정, 지연
- 재고 : 어제 입고/출고, 대기 입고
- 생산 : 열린 요청, 마감 지연·3일내
- VOC : 어제 신규(주요 카테고리), 기준선 일평균 대비
## 주의와 인사이트
- 집계로 뒷받침되는 신호만 2~4개(지연>0, 대기>0, 증감률 큰 폭 등). 정말 없으면 "- 특이사항 없음" 한 줄.
## 오늘 챙길 것
- 오늘 실행할 일(발송 예정 처리, 마감 임박 생산 등) 2~3개
(도구변경 배열이 비어있지 않으면 마지막에 "## 도구 업데이트" 로 한 줄씩.)`;

// 브리핑 생성(하루 한 건, force = 재생성).
//  순서가 중요: 집계를 먼저 저장(insight 는 기존 값 유지)하고 AI 는 그 뒤에 붙인다 —
//  AI 실패·함수 타임아웃에도 집계는 남고, 103 미적용이면 AI 호출 전에 안내로 끝난다(토큰 보호).
export async function generateBriefing(opts?: { date?: string; force?: boolean }): Promise<{ ok: boolean; date: string; skipped?: string; error?: string }> {
  const sb = supabaseAdmin();
  const date = opts?.date && DATE_RE.test(opts.date) ? opts.date : kstDate(0);

  const { data: ex, error: exErr } = await sb.from("briefings").select("brief_date, insight").eq("brief_date", date).maybeSingle();
  if (exErr && /briefings/i.test(exErr.message)) return { ok: false, date, error: "migration 103_briefings.sql 적용이 필요합니다." };
  if (ex && !opts?.force) return { ok: true, date, skipped: "이미 생성됨" };

  const data = await collectBriefingData(sb, date);
  {
    const { error } = await sb.from("briefings").upsert(
      { brief_date: date, data, insight: (ex?.insight as string | null) ?? null }, { onConflict: "brief_date" });
    if (error) return { ok: false, date, error: error.message };
  }

  try {
    const model = await getFeatureModel("briefing");
    const res = await anthropic.messages.create({
      model, max_tokens: 2000, system: SYSTEM,
      messages: [{ role: "user", content: `브리핑일(오늘): ${date}\n집계:\n${JSON.stringify(data, null, 1)}` }],
    });
    const insight = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim() || null;
    if (insight) await sb.from("briefings").update({ insight, model }).eq("brief_date", date);
  } catch (e) { console.warn("[briefing] AI 생성 실패(집계는 저장됨)", e); }

  return { ok: true, date };
}

// 팀즈 발송 — 설정(briefing_webhook)의 비공개 채널 웹훅으로. 카드가 ## 를 렌더 못해 굵게로 변환.
export async function sendBriefingToTeams(date: string): Promise<{ ok: boolean; error?: string }> {
  const url = await getKv("briefing_webhook");
  if (!url) return { ok: false, error: "브리핑 웹훅 URL이 설정되지 않았습니다 — /briefing 하단 설정에서 등록하세요." };
  const { data } = await supabaseAdmin().from("briefings").select("insight").eq("brief_date", date).maybeSingle();
  const insight = (data?.insight as string | null) || "";
  if (!insight) return { ok: false, error: "보낼 브리핑 본문이 없습니다. 먼저 생성하세요." };
  const [, m, d] = date.split("-");
  const body = insight.replace(/^#{2,3}\s*(.+)$/gm, "**$1**");
  const r = await sendTeamsWebhook(url, body, { title: `아침 브리핑 · ${Number(m)}/${Number(d)}` });
  return r.ok ? { ok: true } : { ok: false, error: r.error || `발송 실패(${r.status})` };
}
