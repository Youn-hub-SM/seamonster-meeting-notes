import type { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "./supabase";
import { getFeatureModelKey } from "./ai-model";
import { MODELS } from "./config";
import { getKv } from "./b2b-settings";
import { CHANGELOG } from "./changelog";
import { getLedgerVelocity } from "./production-velocity";
import { getAllBundles, isBundleId } from "./product-bundles";

// 대표 전용 '일일 업무도우미 리포트' v2 (2026-09-03, migration 103 재사용).
//  두 축: ① 어제 사이트 전체에서 있었던 일 ② 오늘 체크해야 할 요소(코드가 판정한 경보).
//  매출 동향은 넣지 않는다 — 별도 매출 리포트가 있다(대표 확정). 매출은 '업로드 밀림' 경보만 본다.
//  원칙(v1에서 확립): 숫자·목록·경보는 전부 코드가 계산해 공급하고 AI 는 인용만 한다(암산·임의 카운트 금지).
//  생성 = pg_cron(06:30 KST, 운영 — 103 의 cron 블록 재등록 필요) 또는 /briefing 화면.

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

// 리포트 기본 모델 = opus (대표: 더 큰 모델이라도 알찬 내용). 설정(AI 설정 > 일일 리포트)에서 변경 가능.
async function briefingModel(): Promise<string> {
  try {
    const k = await getFeatureModelKey("briefing");
    if (k !== "inherit") return MODELS[k] ?? MODELS.opus;
  } catch { /* 설정 조회 실패 → 기본 */ }
  return MODELS.opus;
}

// 서버 Max Rows 캡(기본 1000) 대비 range 페이징. 호출부는 안정 정렬(.order("id"))을 반드시 건다.
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

// ── 영역별 집계 — 각 블록은 실패해도(테이블 미적용 등) null 로 두고 리포트는 계속 만든다 ──
export async function collectBriefingData(sb: SupabaseClient, briefDate: string) {
  const yst = shiftDate(briefDate, -1);
  const weekFrom = shiftDate(briefDate, -8); // VOC 기준선(어제 제외 직전 7일)
  const weekTo = shiftDate(briefDate, -2);
  const in2days = shiftDate(briefDate, 2);   // 마감 3일내 = 오늘 포함 3일

  // B2B 발주·발송 — 어제 등록 발주를 '업체 맥락'(직전 발주 며칠 만인지, 최근 90일 발주액)과 함께
  const b2b = await (async () => {
    try {
      const ords = await pagedRows<{ company_id: string | null; order_no: string | null; total: number }>(
        () => sb.from("orders").select("company_id, order_no, total").eq("order_date", yst).order("id", { ascending: true }), 2000);
      const cids = [...new Set(ords.map((o) => o.company_id).filter((c): c is string => !!c))];
      const nameBy = new Map<string, string>();
      const lastBy = new Map<string, string>();
      const sumBy = new Map<string, number>();
      if (cids.length) {
        const { data: comps } = await sb.from("companies").select("id, name").in("id", cids);
        for (const c of comps ?? []) nameBy.set(c.id as string, (c.name as string) || "(이름 없음)");
        const since90 = shiftDate(briefDate, -90);
        const hist = await pagedRows<{ company_id: string; order_date: string; total: number }>(
          () => sb.from("orders").select("company_id, order_date, total").in("company_id", cids)
            .gte("order_date", since90).lt("order_date", yst).order("id", { ascending: true }), 5000);
        for (const h of hist) {
          sumBy.set(h.company_id, (sumBy.get(h.company_id) || 0) + (Number(h.total) || 0));
          const cur = lastBy.get(h.company_id);
          if (!cur || h.order_date > cur) lastBy.set(h.company_id, h.order_date);
        }
      }
      const daysAgo = (d: string | undefined) => d ? Math.round((Date.parse(yst + "T00:00:00Z") - Date.parse(d + "T00:00:00Z")) / 86400e3) : null;
      const detail = ords.slice(0, 10).map((o) => {
        const last = o.company_id ? lastBy.get(o.company_id) : undefined;
        return {
          업체: (o.company_id && nameBy.get(o.company_id)) || "(업체 미지정)",
          발주번호: o.order_no,
          금액: Number(o.total) || 0,
          직전_발주일: last ?? null,             // null = 최근 90일 내 첫 발주(신규 또는 오랜만)
          직전_발주로부터_일수: daysAgo(last),
          최근90일_발주액_어제제외: (o.company_id && sumBy.get(o.company_id)) || 0,
        };
      });
      const { count: shipYst } = await sb.from("shipments").select("id", { count: "exact", head: true }).eq("ship_date", yst).eq("status", "발송완료");
      const { count: shipToday } = await sb.from("shipments").select("id", { count: "exact", head: true }).eq("ship_date", briefDate).eq("status", "발송대기");
      const { count: shipLate } = await sb.from("shipments").select("id", { count: "exact", head: true }).lt("ship_date", briefDate).eq("status", "발송대기");
      return {
        어제_신규발주: ords.length,
        어제_신규발주_금액: ords.reduce((s, r) => s + (Number(r.total) || 0), 0),
        어제_발주_상세: detail,
        어제_발송완료: shipYst ?? 0,
        오늘_발송예정: shipToday ?? 0,
        발송_지연: shipLate ?? 0,
      };
    } catch { return null; }
  })();

  // 재고 — 품절·소진임박 경보(판매속도 기반, 세트·비판매 제외) + 어제 입출고 + 대기 입고
  const inventory = await (async () => {
    try {
      const stockRpc = async () => {
        const r = await sb.rpc("inventory_stock", { asof: null, chan: "소매" });
        if (!r.error) return r;
        return sb.rpc("inventory_stock", { asof: null }); // 036 미적용 폴백
      };
      const [stockRes, prodRes, bundles, velocity] = await Promise.all([
        stockRpc(),
        sb.from("products").select("id, sku, name").eq("active", true).limit(5000),
        getAllBundles(sb),
        getLedgerVelocity(undefined, "소매").catch(() => null),
      ]);
      if (stockRes.error || prodRes.error) throw new Error("stock/products");
      const stockBy = new Map<string, number>();
      for (const t of (stockRes.data as { product_id: string; qty: number }[] | null) ?? []) stockBy.set(t.product_id, Number(t.qty) || 0);
      const perSku = velocity?.perSku ?? {};

      const soldout: { 품목: string; sku: string | null; 현재고: number }[] = [];
      const risky: { 품목: string; sku: string | null; 현재고: number; 일평균_출고: number; 소진예상일: number }[] = [];
      for (const p of (prodRes.data as { id: string; sku: string | null; name: string }[]) ?? []) {
        if (isBundleId(bundles, p.id)) continue; // 세트는 자체 재고 없음 — 오탐 방지
        const stock = stockBy.get(p.id) ?? 0;
        const daily = p.sku ? (perSku[p.sku.toUpperCase()] || 0) : 0;
        if (daily <= 0) continue; // 최근 30일 출고가 없는 품목은 경보 대상 아님(소음 방지)
        if (stock <= 0) soldout.push({ 품목: p.name, sku: p.sku, 현재고: stock });
        else if (stock / daily <= 7) risky.push({ 품목: p.name, sku: p.sku, 현재고: stock, 일평균_출고: Math.round(daily * 10) / 10, 소진예상일: Math.round(stock / daily) });
      }
      risky.sort((a, b) => a.소진예상일 - b.소진예상일);

      const txRows = await pagedRows<{ type: string; qty: number; status?: string | null; created_by?: string | null }>(
        () => sb.from("inventory_txns").select("type, qty, status, created_by").eq("txn_date", yst).order("id", { ascending: true }), 10000);
      const done = txRows.filter((r) => r.status !== "대기");
      const sum = (t: string) => done.filter((r) => r.type === t).reduce((s, r) => s + Math.abs(Number(r.qty) || 0), 0);
      const byPerson: Record<string, number> = {};
      for (const r of txRows) { const k = r.created_by || "(미기재)"; byPerson[k] = (byPerson[k] || 0) + 1; }
      const { count: pendIn } = await sb.from("inventory_txns").select("id", { count: "exact", head: true }).eq("type", "입고").eq("status", "대기");
      // 3일 넘게 방치된 대기 입고 — '깜빡한 입고처리' 경보용
      const { count: stalePend } = await sb.from("inventory_txns").select("id", { count: "exact", head: true })
        .eq("type", "입고").eq("status", "대기").lt("txn_date", shiftDate(briefDate, -3));

      return {
        품절_판매중인데_재고없음: soldout.slice(0, 12),
        품절_추가건수: Math.max(0, soldout.length - 12),
        소진임박_7일내: risky.slice(0, 12),
        소진임박_추가건수: Math.max(0, risky.length - 12),
        어제_입고수량: sum("입고"), 어제_출고수량: sum("출고"),
        대기중_입고건수: pendIn ?? 0, 방치된_대기입고_3일초과: stalePend ?? 0,
        어제_재고기록_담당자별_건수: byPerson,
      };
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

  // VOC — 어제 접수된 실제 내용(탈리 설문 포함, 처리결과·원인 함께) + 카테고리 + 기준선
  const voc = await (async () => {
    try {
      const { data } = await sb.from("voc")
        .select("channel, source, category, product, content, resolution, cause, created_by")
        .eq("received_at", yst).order("created_at", { ascending: true }).limit(200);
      const rows = data ?? [];
      const byCat: Record<string, number> = {};
      for (const r of rows) byCat[(r.category as string) || "기타"] = (byCat[(r.category as string) || "기타"] || 0) + 1;
      const { count: wkCnt } = await sb.from("voc").select("id", { count: "exact", head: true }).gte("received_at", weekFrom).lte("received_at", weekTo);
      return {
        어제_신규VOC: rows.length,
        어제_카테고리별: byCat,
        기준선_일평균_신규VOC_직전7일_어제제외: Math.round(((wkCnt ?? 0) / 7) * 10) / 10,
        어제_목록: rows.slice(0, 30).map((r) => ({
          채널: (r.channel as string) || null,
          출처: (r.source as string) || null, // '설문' = 탈리 설문 응답
          카테고리: (r.category as string) || null,
          제품: (r.product as string) || null,
          내용: String(r.content || "").slice(0, 200),
          처리결과: String(r.resolution || "").slice(0, 200) || null,
          원인: String(r.cause || "").slice(0, 120) || null,
          등록자: (r.created_by as string) || null,
        })),
      };
    } catch { return null; }
  })();

  // 팀 활동 — 어제 '누가 무엇을 했는지'(변경기록 원문 + 담당자별) + 신규 상품 등록
  const activity = await (async () => {
    try {
      const { start, end } = kstDayUtc(yst);
      const rows = await pagedRows<{ event_type: string; actor?: string | null; summary?: string | null }>(
        () => sb.from("activity_log").select("event_type, actor, summary").gte("created_at", start).lt("created_at", end).order("id", { ascending: true }), 10000);
      const byType: Record<string, number> = {};
      const byActor: Record<string, number> = {};
      for (const r of rows) {
        byType[r.event_type || "기타"] = (byType[r.event_type || "기타"] || 0) + 1;
        const a = r.actor || "(미기재)";
        byActor[a] = (byActor[a] || 0) + 1;
      }
      const top = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 6);
      let 신규상품: { count: number; 품목: string[] } | null = null;
      try {
        const { data: np } = await sb.from("products").select("name").gte("created_at", start).lt("created_at", end).limit(100);
        신규상품 = { count: (np ?? []).length, 품목: (np ?? []).slice(0, 15).map((p) => p.name as string) };
      } catch { /* 무시 */ }
      return {
        어제_활동건수: rows.length,
        상위_활동유형: Object.fromEntries(top),
        담당자별_활동건수: byActor,
        어제_주요활동: rows.slice(0, 40).map((r) => ({ 담당: r.actor || null, 유형: r.event_type, 내용: String(r.summary || "").slice(0, 120) })),
        어제_등록된_신규상품: 신규상품,
      };
    } catch { return null; }
  })();

  // 전일 리포트의 집계 — '전일 대비' 판단의 근거(없으면 null)
  const prev = await (async () => {
    try {
      const { data } = await sb.from("briefings").select("data").eq("brief_date", yst).maybeSingle();
      return (data?.data as Record<string, unknown>) ?? null;
    } catch { return null; }
  })();

  // 도구 변경 — 어제 이후 업데이트 노트(정적 changelog)
  const toolChanges = CHANGELOG.filter((c) => c.date >= yst).slice(0, 6)
    .map((c) => ({ 날짜: c.date, 구분: c.tag, 도구: c.tool, 제목: c.title }));

  // ── 오늘 체크할 것 — 코드가 판정한 경보 목록(AI 는 그대로 인용). 순서 = 급한 순 ──
  const checks: { 항목: string; 상세: string; 확인위치: string }[] = [];
  if (b2b && b2b.발송_지연 > 0) checks.push({ 항목: "발송 지연", 상세: `발송 예정일이 지났는데 발송대기인 발주 ${b2b.발송_지연}건`, 확인위치: "B2B > 발송 일정" });
  if (b2b && b2b.오늘_발송예정 > 0) checks.push({ 항목: "오늘 발송 예정", 상세: `오늘 나가야 할 발송 ${b2b.오늘_발송예정}건`, 확인위치: "B2B > 발송 일정" });
  if (production && production.마감_지연 > 0) checks.push({ 항목: "생산 마감 지연", 상세: `마감일이 지난 열린 생산요청 ${production.마감_지연}건`, 확인위치: "생산 관리 > 생산요청" });
  if (production && production.마감_3일내 > 0) checks.push({ 항목: "생산 마감 임박", 상세: `3일 내 마감 생산요청 ${production.마감_3일내}건`, 확인위치: "생산 관리 > 생산요청" });
  if (inventory && inventory.품절_판매중인데_재고없음.length > 0) checks.push({ 항목: "품절", 상세: `판매 중인데 재고가 없는 품목 ${inventory.품절_판매중인데_재고없음.length + inventory.품절_추가건수}종 — 보충 발주/생산 판단 필요`, 확인위치: "재고 목록" });
  if (inventory && inventory.소진임박_7일내.length > 0) checks.push({ 항목: "소진 임박", 상세: `7일 내 소진 예상 ${inventory.소진임박_7일내.length + inventory.소진임박_추가건수}종(아래 표)`, 확인위치: "재고 목록" });
  if (inventory && inventory.방치된_대기입고_3일초과 > 0) checks.push({ 항목: "대기 입고 방치", 상세: `3일 넘게 '대기' 상태인 입고 ${inventory.방치된_대기입고_3일초과}건 — 실물이 왔다면 입고처리`, 확인위치: "입고 및 출고" });
  try {
    const { data: lastRow } = await sb.from("sales_orders").select("order_date").lte("order_date", yst).order("order_date", { ascending: false }).limit(1);
    const lastDate = lastRow?.length ? String(lastRow[0].order_date).slice(0, 10) : null;
    if (lastDate) {
      const gap = Math.round((Date.parse(yst + "T00:00:00Z") - Date.parse(lastDate + "T00:00:00Z")) / 86400e3);
      if (gap >= 2) checks.push({ 항목: "매출 업로드 밀림", 상세: `매출 데이터가 ${lastDate}까지만 입력됨(${gap}일 밀림)`, 확인위치: "매출 > 데이터 업로드" });
    }
  } catch { /* 매출 테이블 미적용 등 — 생략 */ }
  try {
    const prevMonth = shiftDate(`${briefDate.slice(0, 7)}-01`, -1).slice(0, 7);
    const { data: snap, error: se } = await sb.from("quote_snapshots").select("month").eq("month", prevMonth).maybeSingle();
    if (!se && !snap) checks.push({ 항목: "지난달 매입 결산 미확정", 상세: `${Number(prevMonth.slice(5))}월 결산이 아직 확정되지 않음`, 확인위치: "재고 관리 > 월간매입 결산" });
  } catch { /* 101 미적용 — 생략 */ }
  if (voc && voc.기준선_일평균_신규VOC_직전7일_어제제외 > 0 && voc.어제_신규VOC >= 3 && voc.어제_신규VOC >= voc.기준선_일평균_신규VOC_직전7일_어제제외 * 2)
    checks.push({ 항목: "VOC 급증", 상세: `어제 신규 ${voc.어제_신규VOC}건 — 평소 일평균 ${voc.기준선_일평균_신규VOC_직전7일_어제제외}건의 2배 이상`, 확인위치: "VOC 처리" });

  return { 기준일_어제: yst, 발주와발송: b2b, 재고: inventory, 생산: production, VOC: voc, 팀활동: activity, 전일_리포트_집계: prev, 도구변경: toolChanges, 오늘_체크할것: checks };
}

const SYSTEM = `당신은 씨몬스터(수산물 이커머스) 대표의 '일일 업무도우미 리포트' 비서다. 내부 업무도구 전 영역에서 어제 일어난 일과 오늘 점검할 요소를 정리해, 대표가 아침에 읽고 바로 움직일 수 있게 쓴다. 매출 분석은 이 리포트의 몫이 아니다(별도 매출 리포트 존재) — 매출은 '업로드 밀림' 경보가 있을 때만 언급한다.

규칙:
- 모든 줄이 핵심이어야 한다. 요약의 요약, 빈약한 나열, 하나마나 한 문장 금지.
- 반드시 제공된 집계 숫자·목록·경보만 인용한다. 없는 숫자를 만들거나 목록을 임의로 세지 않는다.
- '평소보다' 류의 상대 판단은 기준선 필드나 전일_리포트_집계가 뒷받침할 때만.
- 값이 null 인 영역은 언급하지 않는다. 이모지 금지. 간결한 존댓말. 금액은 천 단위 콤마 + '원'.
- 출력은 마크다운만: "## 제목" 섹션, "- 라벨 : 내용" 불릿, 표.

골격(순서 고정):
## 어제 있었던 일
어제 실제로 일어난 사건을 영역별로 서술한다. 사건이 없던 영역은 통째로 생략:
- 발주 : 어제_발주_상세를 업체 맥락과 함께 건별로("업체명 — 금액. 직전 발주 N일 만, 최근 90일 발주액 M원". 직전_발주일 null 이면 "최근 90일 내 첫 발주"). 발송완료 건수도 있으면 한 줄
- 재고 : 어제 입고/출고 수량(0이면 생략)
- VOC : 어제_목록의 내용을 건별 한 줄("제품 — 내용 요지 → 처리결과"). VOC 는 담당자가 이미 응대·처리를 마친 공유 기록이다 — "응대 필요" 류 지시 금지. 출처 '설문'(탈리)은 설문 응답으로 구분. 반복 조짐이 보일 때만 관찰 한 줄
- 생산 : 열린 요청 수의 변화(전일_리포트_집계와 비교 가능할 때만)
- 상품마스터 : 어제_등록된_신규상품 있으면 품목명과 함께
- 팀 활동 : 담당자별로 무엇을 했는지 한 줄씩("현석 — 발주 2건 처리, 입고 기록 5건"). 어제_주요활동 원문에서 의미 있는 것만
- 모두 한산하면 "- 조용한 하루였습니다(도구 활동 N건)" 한 줄
## 오늘 체크할 것
- 오늘_체크할것 배열을 순서대로 항목별 한 줄: "- 항목 : 상세 — 확인: 확인위치"
- 소진 임박 항목이 있으면 바로 아래에 마크다운 표(소진예상일 오름차순 전건):
| 품목 | 현재고 | 일평균 출고 | 소진예상 |
|---|---|---|---|
- 배열이 비어 있으면 "- 특이 경보 없음" 한 줄
(도구변경 배열이 비어있지 않으면 마지막에 "## 도구 업데이트" 로 한 줄씩.)`;

// 리포트 생성(하루 한 건, force = 재생성).
//  순서: 103 확인(미적용이면 AI 전에 종료 — 토큰 보호) → 집계 upsert(기존 insight 보존) → AI(update).
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
    const model = await briefingModel();
    const res = await anthropic.messages.create({
      model, max_tokens: 3000, system: SYSTEM,
      messages: [{ role: "user", content: `리포트일(오늘): ${date}\n집계:\n${JSON.stringify(data, null, 1)}` }],
    });
    const insight = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim() || null;
    if (insight) await sb.from("briefings").update({ insight, model }).eq("brief_date", date);
  } catch (e) { console.warn("[briefing] AI 생성 실패(집계는 저장됨)", e); }

  return { ok: true, date };
}

// ── 팀즈 발송 — 리포트 전용 적응형 카드(모바일 wrap, 표 = ColumnSet 숫자 우측정렬) ──
type CardEl = Record<string, unknown>;

function briefingCardBody(title: string, md: string): CardEl[] {
  const body: CardEl[] = [{ type: "TextBlock", text: title, weight: "Bolder", size: "Large", wrap: true }];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^\|.*\|$/.test(t)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const raw = lines[i].trim();
        if (!/^\|[\s|:-]+\|$/.test(raw)) rows.push(raw.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        i++;
      }
      i--;
      if (rows.length) {
        const [head, ...dataRows] = rows;
        const colSet = (cells: string[], bold: boolean, sep: boolean): CardEl => ({
          type: "ColumnSet",
          spacing: "None",
          separator: sep,
          columns: cells.map((c, k) => ({
            type: "Column",
            width: k === 0 ? "stretch" : "auto",
            items: [{
              type: "TextBlock", text: c || " ", wrap: true, size: "Small",
              weight: bold ? "Bolder" : "Default",
              horizontalAlignment: k === 0 ? "Left" : "Right",
            }],
          })),
        });
        body.push(colSet(head, true, true));
        for (const r of dataRows) body.push(colSet(r, false, false));
      }
      continue;
    }
    if (!t || t === "---") continue;
    if (/^##\s/.test(t)) { body.push({ type: "TextBlock", text: t.replace(/^##\s*/, ""), weight: "Bolder", size: "Medium", spacing: "Large", wrap: true }); continue; }
    if (/^###\s/.test(t)) { body.push({ type: "TextBlock", text: t.replace(/^###\s*/, ""), weight: "Bolder", spacing: "Medium", wrap: true }); continue; }
    if (/^-\s/.test(t)) { body.push({ type: "TextBlock", text: "• " + t.replace(/^-\s*/, ""), wrap: true, spacing: "Small" }); continue; }
    body.push({ type: "TextBlock", text: t, wrap: true, spacing: "Small" });
  }
  return body;
}

const cardPayload = (body: CardEl[]) => ({
  type: "message",
  attachments: [{
    contentType: "application/vnd.microsoft.card.adaptive",
    contentUrl: null,
    content: {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.4",
      body,
      msteams: { width: "Full" },
    },
  }],
});

export async function sendBriefingToTeams(date: string): Promise<{ ok: boolean; error?: string }> {
  const url = await getKv("briefing_webhook");
  if (!url) return { ok: false, error: "웹훅 URL이 설정되지 않았습니다 — /briefing 하단 설정에서 등록하세요." };
  const { data } = await supabaseAdmin().from("briefings").select("insight").eq("brief_date", date).maybeSingle();
  const insight = (data?.insight as string | null) || "";
  if (!insight) return { ok: false, error: "보낼 리포트 본문이 없습니다. 먼저 생성하세요." };
  const [, m, d] = date.split("-");
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cardPayload(briefingCardBody(`일일 리포트 · ${Number(m)}/${Number(d)}`, insight))),
    });
    if (!res.ok) return { ok: false, error: `발송 실패(${res.status}) — 워크플로 실행 기록을 확인하세요.` };
    return { ok: true };
  } catch {
    return { ok: false, error: "발송 실패: 네트워크 오류" };
  }
}
