import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { logInventoryPoolMoved, logProductionRequestStatusChanged, logProductionRequestUpdated } from "@/app/lib/b2b-activity";
import { addBusinessDays } from "@/app/lib/business-days";
import { getKv, setKv } from "@/app/lib/b2b-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/inventory/promotion/release — 프로모션 풀 자동 합류(113).
//  시점 = **행사 시작(목표일) 하루 전 아침**(2026-09-23 대표 지시 — H-24 엔 행사 준비가 끝나 있어야 한다.
//  행사 판매는 소매에서 나가므로 시작 전에 재고가 소매에 가 있어야 한다. 종전: 목표일 지난 다음날).
//  중계 서버가 매일 아침(09:00 KST) 호출 — 운영(main)에서만 돈다. 그날 하는 일 두 가지:
//   ① 목표일이 내일(이하)인 열린 프로모션 요청서를 자동 완료로 닫는다 — 이동 화면 배정 목록에서 빠지고,
//      그 다음 입고분은 옮길 곳 없이 소매에 그대로 남는다(대표: "그 다음 입고건부터는 소매로 바로").
//   ② 잡는 요청서(비취소·목표일 모레 이후 또는 목표일 없음)가 더는 없는 품목의 풀 잔량을
//      전량 프로모션→소매로 이동(사람의 이동과 같은 원장 기록·취소 가능).
//   부수 규칙: 배정 100% 로 이미 완료된 요청서도 행사 하루 전 겹침 경고(#13) · 옛 기본 마감일 요청서는 보류+경고(#22)
//   · 목표일 지난 백로그는 정리 마감 문구(#63) · 합류 수량은 오늘까지의 풀(#64) · 한 번 닫은 요청서는 다시 안 닫음(#14).
//  메모 문자열 '행사 종료 자동 합류'는 옛 이름이지만 멱등 가드·기존 원장과의 호환을 위해 그대로 둔다.
//  미들웨어 예외 경로 — Bearer(카탈로그 업로드 공용 시크릿 또는 CRON_SECRET)로 인증.
const MARK = "채널이동";
// 프로모션 요청서의 목표일을 '행사 시작일'로 믿기 시작하는 시점 = 이 코드가 운영에서 처음 돈 시각(b2b_settings 'promo_due_trusted_from' 에 한 번 기록).
//  배포일을 코드에 박으면 배포가 늦어질 때 옛 화면의 [확인](옛 코드는 수정 알림을 남김)·옛 화면 작성분이 기준 뒤로 넘어가 가드가 풀린다.
//  아래 상수는 kv 를 읽지도 쓰지도 못할 때의 폴백.
//  구화면은 프로모션 요청서에도 기본 마감일(요청일·작성일 +7영업일)을 그대로 저장했다. 그래서 이 날 전에 만들어졌고
//  목표일이 그 기본값 모양이며, 이 날 이후 사람이 수정 창에서 한 번도 저장하지 않은 요청서는 마감·합류하지 않고 경고만 낸다(#22).
//  '사람의 저장' = activity_log 의 production_request.updated(수정 창 저장은 품목을 늘 보내 항상 남는다) — [확인]·배정·다시 열기는
//  status_changed 만 남기므로 확인으로 치지 않는다(updated_at 은 이것들로도 바뀌어 기준이 될 수 없다).
const PROMO_DUE_TRUSTED_FROM = "2026-09-29";
const PROMO_DUE_TRUSTED_FROM_ISO = new Date(`${PROMO_DUE_TRUSTED_FROM}T00:00:00+09:00`).toISOString();
// 이 크론이 남기는 production_request.updated 작업자 문구 — 사람의 저장과 구분(확인 판정에서 제외)하므로 바꾸지 말 것
const LEGACY_WARN_ACTOR = "행사 시작일 확인 필요 — 자동 마감·합류 보류";
const HOLD_WARN_ACTOR = "행사 하루 전 합류 보류 경고";
const REOPEN_SKIP_ACTOR = "재개된 요청서 — 자동 마감 건너뜀";
const CRON_ACTORS = new Set([LEGACY_WARN_ACTOR, HOLD_WARN_ACTOR, REOPEN_SKIP_ACTOR]);
const kstDateOf = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);
// 마감 알림의 작업자 문구 — activity_log 에 남아 '이 크론이 이미 닫은 요청서' 판정(#14)의 근거가 되므로 바꾸지 말 것.
const CLOSE_ACTOR_D1 = "행사 하루 전 자동 마감";
const CLOSE_ACTOR_BACKLOG_SUFFIX = "지난 요청서 정리 마감";
const closeActorBacklog = (due: string) => `목표일(${due}) ${CLOSE_ACTOR_BACKLOG_SUFFIX}`;

function bearerOk(req: NextRequest): boolean {
  const authz = req.headers.get("authorization") || "";
  const keys = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET];
  return keys.some((k) => k && k.trim() && authz === `Bearer ${k.trim()}`);
}

export async function POST(req: NextRequest) {
  try {
    if (!bearerOk(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const sb = supabaseAdmin();
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10); // KST 내일 = 행사 하루 전 판정 기준
    // 신뢰 기준 시각 — 첫 실행에 기록(이후 고정). 읽기·쓰기 실패면 상수 폴백.
    let trustedFrom = PROMO_DUE_TRUSTED_FROM_ISO;
    try {
      const saved = await getKv("promo_due_trusted_from");
      if (saved && !Number.isNaN(Date.parse(saved))) trustedFrom = saved;
      else { trustedFrom = new Date().toISOString(); await setKv("promo_due_trusted_from", trustedFrom); }
    } catch { trustedFrom = PROMO_DUE_TRUSTED_FROM_ISO; }
    // 최근 7일 안에 같은 작업자 문구로 같은 요청서에 남긴 알림 — 같은 경고를 매일 반복하지 않게
    const recentNotices = async (actor: string): Promise<Set<string>> => {
      try {
        const since = new Date(Date.parse(`${today}T00:00:00+09:00`) - 6 * 86400e3).toISOString();
        const { data: w } = await sb.from("activity_log").select("meta").eq("event_type", "production_request.updated")
          .eq("actor", actor).gte("created_at", since).limit(1000);
        return new Set((w ?? []).map((x) => String(((x as { meta?: { req_no?: string } | null }).meta || {}).req_no || "")));
      } catch { return new Set(); } // 조회 실패면 알림을 보낸다
    };

    // 1) 프로모션 풀 잔량 — 마감(2a)·겹침 경고·합류가 모두 쓴다. 풀이 비어도 마감은 해야 하므로
    //    빈 풀의 이른 반환은 마감 뒤로 미룬다.
    const pool = await sb.rpc("inventory_stock", { asof: null, chan: "프로모션" });
    if (pool.error) {
      if (/channel/i.test(pool.error.message)) return NextResponse.json({ ok: true, released: 0, closed: 0, note: "113 미적용 — 프로모션 풀 없음" });
      throw pool.error;
    }
    //    합류 수량은 '오늘까지의 풀'로 제한(#64) — 미래 날짜로 기록된 소매→프로모션 이동분까지 오늘 날짜로 빼면
    //    기준일 조회에서 프로모션 음수·소매 과대가 생긴다. 그 분량은 날짜가 오면 그날 크론이 합류시킨다.
    //    (오늘 기준 RPC 가 실패하면 종전대로 전체 잔량 — 폴백이 없으면 크론이 통째로 멈춘다)
    const poolToday = await sb.rpc("inventory_stock", { asof: today, chan: "프로모션" });
    const todayQty = new Map(((poolToday.error ? null : (poolToday.data as { product_id: string; qty: number }[] | null)) ?? [])
      .map((r) => [r.product_id, Number(r.qty) || 0]));
    const allRows = ((pool.data as { product_id: string; qty: number }[] | null) ?? [])
      .map((r) => ({ product_id: r.product_id, qty: Math.round((Number(r.qty) || 0) * 100) / 100 }))
      .filter((r) => r.qty > 0);
    const poolQty = new Map(allRows.map((r) => [r.product_id, r.qty])); // 전체 잔량 — 겹침 경고 문구용
    const rows = allRows
      .map((r) => ({ product_id: r.product_id, qty: Math.round(Math.min(r.qty, poolToday.error ? Infinity : (todayQty.get(r.product_id) ?? 0)) * 100) / 100 }))
      .filter((r) => r.qty > 0);

    // 2) 보류 판정(2026-09-23 개정) — 잡는 힘 = '목표일이 모레 이후(또는 목표일 없음)인 비취소 프로모션 요청'.
    //    목표일이 내일(이하)인 요청은 아래 2a 가 닫는다 — 상태 구분이 더는 필요 없다
    //    (2a 마감이 실패한 열린 요청도 날짜 기준으로 합류 — 행사 하루 전엔 무조건 소매에 있어야 한다).
    //    목표일 없는 요청은 보수적으로 보류(행사 연기 시 목표일 수정을 잊어도 확보분이 사라지지 않게).
    //    조회 실패는 무조건 throw — 1단계(풀 RPC)가 성공한 환경은 113 적용이 확정이라 폴백이 옳은 경우가 없고,
    //    조용한 폴백은 '실패 → 보호 해제(전량 합류)' 방향 사고가 된다(검증 확정).
    //    잡는 조건(목표일 없음 또는 모레 이후)을 SQL 로 내려보내 과거 행사 품목행 누적을 배제하고,
    //    range 페이징으로 전량 읽는다 — 서버 Max Rows(기본 1000)가 .limit 보다 우선해 조용히 잘리면
    //    미래 행사 품목이 보류에서 빠져 조기 합류되는 '보호 해제' 방향 사고가 된다(리뷰 확정).
    const held = new Set<string>();
    {
      type Rel = { purpose?: string; status?: string; due_date?: string | null };
      for (let off = 0; off < 20000; off += 1000) {
        const { data: items, error: ie } = await sb.from("production_request_items")
          .select("product_id, production_requests!inner(purpose, status, due_date)")
          .eq("production_requests.purpose", "프로모션")
          .neq("production_requests.status", "취소")
          .or(`due_date.is.null,due_date.gt.${tomorrow}`, { referencedTable: "production_requests" })
          .order("id", { ascending: true })
          .range(off, off + 999);
        if (ie) throw ie;
        const rows2 = (items ?? []) as { product_id: string; production_requests?: Rel | Rel[] }[];
        for (const it of rows2) {
          const rel = it.production_requests;
          const h = Array.isArray(rel) ? rel[0] : rel;
          if (!h) continue;
          const dueLater = !h.due_date || String(h.due_date) > tomorrow; // SQL 필터와 동일 — 이중 확인
          if (dueLater) held.add(String(it.product_id));
        }
        if (rows2.length < 1000) break;
      }
    }
    // 요청서 품목명 조회(경고 문구용) — 여러 블록이 같은 모양으로 쓴다
    const namesOf = async (ids: string[]): Promise<Map<string, string>> => {
      if (!ids.length) return new Map();
      const { data: ps } = await sb.from("products").select("id, name").in("id", ids).limit(500);
      return new Map((ps ?? []).map((pr) => [String(pr.id), String(pr.name || "품목")]));
    };
    const stuckLines = (stuck: string[], nm: Map<string, string>) =>
      stuck.map((pid) => `- ${nm.get(pid) || pid} ×${(poolQty.get(pid) || 0).toLocaleString()}`);

    // 2-레거시) 첫 실행 안전장치(#22) — 목표일이 내일(이하)이지만 구화면 기본 마감일(요청일+7영업일)일 수 있는
    //    옛 요청서(배포 전 생성 + 배포 뒤 무저장)는 닫지도 합류시키지도 않는다: 품목을 보류에 넣고 경고만.
    //    조회 실패는 throw — 여기서 조용히 넘기면 '실패 → 보호 해제(조기 합류)' 방향 사고가 된다.
    const legacyIds = new Set<string>();
    {
      // 대상 = 2a 가 닫을 열린 요청서 + 오늘·내일이 행사인 완료 요청서(이미 끝난 행사의 완료 요청서는 옛 크론이 이미 풀었다 — 보류하면 그 품목이 영영 합류하지 않는다)
      const { data: cand, error: le } = await sb.from("production_requests")
        .select("id, req_no, status, due_date, request_date, created_at")
        .eq("purpose", "프로모션").neq("status", "취소")
        .not("due_date", "is", null).lte("due_date", tomorrow)
        .or(`status.in.(요청,진행중),due_date.gte.${today}`)
        .lt("created_at", trustedFrom)
        .limit(500);
      if (le) throw le;
      // 옛 기본값 모양(요청일 또는 작성일 +7영업일)인 것 + 목표일이 이미 지난 열린 요청서 — 옛 크론은 열린 요청서를 날짜와 무관하게
      //  잡아 두었으므로(행사 연기 시 날짜를 안 고쳐도 안전했다) 지난 날짜로 곧장 마감·합류하면 확보분이 조기에 풀린다.
      const looksDefault = (cand ?? []).filter((r) => {
        const due = String(r.due_date);
        const open = r.status === "요청" || r.status === "진행중";
        return (open && due < today) || due === addBusinessDays(String(r.request_date), 7) || due === addBusinessDays(kstDateOf(String(r.created_at)), 7);
      });
      // 배포 뒤 사람이 수정 창에서 저장했으면 확인된 것(크론 자신의 경고 기록은 빼고 본다)
      const confirmed = new Set<string>();
      const reqNos = looksDefault.map((r) => String(r.req_no || "")).filter(Boolean);
      if (reqNos.length) {
        const { data: logs, error: lge } = await sb.from("activity_log").select("actor, meta")
          .eq("event_type", "production_request.updated").gte("created_at", trustedFrom)
          .in("meta->>req_no", reqNos).limit(2000);
        if (lge) throw lge;
        for (const l of logs ?? []) {
          const a = String((l as { actor?: string | null }).actor || "");
          if (CRON_ACTORS.has(a)) continue;
          const rn = String(((l as { meta?: { req_no?: string } | null }).meta || {}).req_no || "");
          if (rn) confirmed.add(rn);
        }
      }
      const legacy = looksDefault.filter((r) => !confirmed.has(String(r.req_no || "")));
      for (const r of legacy) legacyIds.add(String(r.id));
      if (legacyIds.size) {
        const { data: its, error: ie } = await sb.from("production_request_items")
          .select("request_id, product_id").in("request_id", [...legacyIds]).limit(2000);
        if (ie) throw ie;
        const byReq = new Map<string, string[]>();
        for (const it of its ?? []) {
          held.add(String(it.product_id));
          byReq.set(String(it.request_id), [...(byReq.get(String(it.request_id)) ?? []), String(it.product_id)]);
        }
        // 경고 — 열린 요청서는 늘, 완료 요청서는 풀에 잔량이 잡혀 있을 때만. 같은 요청서는 7일에 한 번(매일 같은 게시물 방지)
        const recentWarned = await recentNotices(LEGACY_WARN_ACTOR);
        for (const r of legacy) {
          const pids = [...new Set(byReq.get(String(r.id)) ?? [])];
          const stuck = pids.filter((pid) => (poolQty.get(pid) || 0) > 0);
          const open = r.status === "요청" || r.status === "진행중";
          if (!open && !stuck.length) continue;
          if (open && recentWarned.has(String(r.req_no || ""))) continue; // 완료 요청서는 보류가 곧 끝나므로 매일 알린다
          try {
            const nm = await namesOf(stuck);
            const detail = [
              `목표일 ${r.due_date} 이(가) 옛 화면의 기본 마감일일 수 있어 자동 마감·합류를 건너뛰었습니다.`,
              open
                ? "요청서 행의 '수정'에서 행사 시작일을 확인하고 '수정 저장'을 누르세요 — 다음 날부터 자동 처리됩니다('확인'·배정·다시 열기로는 풀리지 않습니다). 행사가 이미 끝났으면 '마감'을 누르세요."
                : `완료된 요청서입니다 — 이 보류는 ${new Date(Date.parse(`${r.due_date}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10)} 아침에 끝나 확보분이 소매로 합류합니다. 행사가 그 뒤라면 그 전에 '완료·취소 보기' → '다시 열기' → '수정'에서 행사 시작일을 저장하세요(새 날짜 하루 전에 자동 마감). 행사가 맞다면 '재고 이동'에서 프로모션 → 소매 로 옮기세요.`,
              ...(stuck.length ? ["잡아 둔 품목:", ...stuckLines(stuck, nm)] : []),
            ].join("\n");
            await logProductionRequestUpdated(String(r.req_no || ""), LEGACY_WARN_ACTOR, detail);
          } catch { /* 경고 실패는 보류를 막지 않는다 */ }
        }
      }
    }

    // 2a) 행사 하루 전 요청서 자동 마감(2026-09-23 대표 지시) — 목표일이 내일(이하)인 열린 프로모션
    //    요청서를 완료로 닫는다. 이행률과 무관(문을 닫는 게 목적). 닫힌 요청서의 품목이 다른 미래
    //    요청서에 묶여 오늘 합류하지 못하면 마감 알림 본문에 경고를 남긴다(리뷰 확정 — 이번 주 행사가
    //    확보분 없이 치러질 수 있는데 조용히 넘기면 사람이 알 길이 없다).
    //    목표일이 이미 지난 요청서(백로그)는 '행사 하루 전'이 아니라 정리 마감 — 경고·직접 옮기기 안내를 붙이지
    //    않는다(#63: 다음 행사 확보분을 소매로 빼게 유도하는 문구가 된다).
    //    이 크론이 한 번 닫은 요청서(이동 취소로 재개된 것)는 다시 닫지 않는다(#14) — 판정 근거는 activity_log 의
    //    마감 기록(작업자 문구). 조회 실패면 종전대로 닫는다.
    //    113 미적용(purpose 없음)이면 1단계 풀 RPC 가 어차피 빈손이라 여기 오류는 조용히 넘긴다.
    let closed = 0;
    let reclosedSkipped = 0;
    let reopenNoticed: Set<string> | undefined;
    const closedIds = new Set<string>();
    //  '같은 행사'로 닫은 기록만 센다 — 행사가 미뤄져 다시 열고 목표일을 옮긴 요청서는 새 목표일 기준으로 다시 닫는다.
    //  하루 전 마감 = 마감일(KST)이 지금 목표일의 하루 전 이후, 백로그 마감 = 작업자 문구의 목표일이 지금 목표일과 같음.
    const closedByCronBefore = async (reqNo: string, due: string): Promise<boolean> => {
      if (!reqNo) return false;
      try {
        const { data, error } = await sb.from("activity_log").select("actor, created_at")
          .eq("event_type", "production_request.status_changed").eq("meta->>req_no", reqNo).eq("meta->>to", "완료").limit(100);
        if (error) return false;
        return (data ?? []).some((a) => {
          const s = String(a.actor || "");
          if (s === CLOSE_ACTOR_D1) return kstDateOf(String(a.created_at)) >= dayBefore(due);
          return s === closeActorBacklog(due);
        });
      } catch { return false; }
    };
    try {
      const { data: dueReqs } = await sb.from("production_requests")
        .select("id, req_no, status, due_date")
        .eq("purpose", "프로모션").in("status", ["요청", "진행중"])
        .not("due_date", "is", null).lte("due_date", tomorrow).limit(200);
      for (const r of dueReqs ?? []) {
        if (legacyIds.has(String(r.id))) continue; // #22 — 경고만 냈다
        if (await closedByCronBefore(String(r.req_no || ""), String(r.due_date))) {
          // #14 — 같은 행사로 한 번 닫았다가 재개된 요청서는 사람이 닫는다. 조용히 두면 행사가 끝나도 열린 채 남으므로 7일에 한 번 알린다.
          reclosedSkipped++;
          const rn = String(r.req_no || "");
          if (rn && !(reopenNoticed ??= await recentNotices(REOPEN_SKIP_ACTOR)).has(rn)) {
            try { await logProductionRequestUpdated(rn, REOPEN_SKIP_ACTOR, "같은 행사로 자동 마감했던 요청서가 다시 열려 있습니다 — 행사가 끝났으면 행의 '마감'을 누르세요. 행사를 미뤘으면 '수정'에서 행사 시작일을 고치면 새 날짜 하루 전에 자동 마감됩니다."); } catch { /* 알림 실패 무시 */ }
          }
          continue;
        }
        const { data: flipped, error: ue } = await sb.from("production_requests")
          .update({ status: "완료", updated_at: new Date().toISOString() })
          .eq("id", r.id).in("status", ["요청", "진행중"]).select("id"); // 경합 시 한 번만 전환
        if (ue || !flipped?.length) continue;
        closed++;
        closedIds.add(String(r.id));
        const pastDue = !!r.due_date && String(r.due_date) < today; // 목표일이 어제 이전 = 백로그 정리(#63)
        let detail: string | undefined;
        try {
          const { data: its } = await sb.from("production_request_items").select("product_id").eq("request_id", r.id).limit(500);
          const stuck = [...new Set((its ?? []).map((x) => String(x.product_id)))]
            .filter((pid) => held.has(pid) && (poolQty.get(pid) || 0) > 0);
          if (stuck.length && !pastDue) {
            const nm = await namesOf(stuck);
            detail = [
              "주의 — 확보분이 소매로 합류하지 않은 품목(다음 행사 요청서가 잡고 있음):",
              ...stuckLines(stuck, nm),
              "이번 행사에 쓰려면 '재고 이동'에서 프로모션 → 소매 로 직접 옮기세요.",
            ].join("\n");
          }
        } catch { /* 경고 없이 마감 */ }
        const actor = pastDue ? closeActorBacklog(String(r.due_date)) : CLOSE_ACTOR_D1;
        try { await logProductionRequestStatusChanged(String(r.req_no || ""), String(r.status), "완료", actor, detail); } catch { /* 알림 실패는 마감을 막지 않는다 */ }
      }
    } catch { /* 조회 실패 — 마감 없이 합류로 진행(다음 날 재시도) */ }

    // 2a') 배정 100% 로 이미 '완료'된 요청서(#13) — 2a 마감 알림이 없으니 겹침(합류 보류) 경고도 빠진다.
    //    목표일이 정확히 내일인 완료 요청서만 보므로 요청서당 하루 한 번(같은 날 재호출이면 한 번 더 — 허용).
    try {
      const { data: doneReqs } = await sb.from("production_requests")
        .select("id, req_no").eq("purpose", "프로모션").eq("status", "완료").eq("due_date", tomorrow).limit(200);
      for (const r of (doneReqs ?? []).filter((x) => !closedIds.has(String(x.id)) && !legacyIds.has(String(x.id)))) {
        const { data: its } = await sb.from("production_request_items").select("product_id").eq("request_id", r.id).limit(500);
        const stuck = [...new Set((its ?? []).map((x) => String(x.product_id)))]
          .filter((pid) => held.has(pid) && (poolQty.get(pid) || 0) > 0);
        if (!stuck.length) continue;
        const nm = await namesOf(stuck);
        const detail = [
          "주의 — 확보분이 소매로 합류하지 않은 품목(다음 행사 요청서가 잡고 있음):",
          ...stuckLines(stuck, nm),
          "이번 행사에 쓰려면 '재고 이동'에서 프로모션 → 소매 로 직접 옮기세요.",
        ].join("\n");
        try { await logProductionRequestUpdated(String(r.req_no || ""), HOLD_WARN_ACTOR, detail); } catch { /* 알림 실패 무시 */ }
      }
    } catch { /* 경고 없이 진행 */ }

    const stats = { closed, reclosedSkipped, legacy: legacyIds.size };
    if (!rows.length) return NextResponse.json({ ok: true, released: 0, ...stats });
    let release = rows.filter((r) => !held.has(r.product_id));
    if (!release.length) return NextResponse.json({ ok: true, released: 0, ...stats, held: held.size });

    // 2b) 멱등 가드 — 오늘 이미 자동 합류가 기록된 품목은 스킵(타임아웃 재시도·중복 호출 시 이중 이동 방지)
    {
      const { data: doneToday } = await sb.from("inventory_txns")
        .select("product_id").eq("partner", MARK).eq("memo", "행사 종료 자동 합류")
        .eq("txn_date", today).eq("channel", "프로모션").in("product_id", release.map((r) => r.product_id)).limit(2000);
      const doneSet = new Set((doneToday ?? []).map((r) => String(r.product_id)));
      release = release.filter((r) => !doneSet.has(r.product_id));
      if (!release.length) return NextResponse.json({ ok: true, released: 0, ...stats, held: held.size, note: "오늘 이미 합류됨" });
    }

    // 3) 품목별 프로모션→소매 이동(각자 group — 내역·취소 규칙은 사람 이동과 동일)
    const { data: prods } = await sb.from("products").select("id, name, sku").in("id", release.map((r) => r.product_id));
    const nameById = new Map((prods ?? []).map((p) => [p.id as string, { name: String(p.name || "품목"), sku: (p.sku as string) ?? null }]));
    const done: { product_id: string; qty: number }[] = [];
    const failed: string[] = [];
    for (const r of release) {
      const base = { product_id: r.product_id, partner: MARK, memo: "행사 종료 자동 합류", group_id: randomUUID(), txn_date: today, status: "완료", created_by: "자동" };
      const { error } = await sb.from("inventory_txns").insert([
        { ...base, type: "출고", qty: -r.qty, channel: "프로모션", unit_amount: null },
        { ...base, type: "입고", qty: r.qty, channel: "소매", unit_amount: null },
      ]);
      if (error) { console.warn("[promotion/release] 이동 기록 실패:", error.message); failed.push(nameById.get(r.product_id)?.name || r.product_id); continue; }
      done.push(r);
    }
    // 전건 실패는 5xx — ok:true 로 조용히 넘어가면 크론 실패 감지에 안 걸려 풀이 계속 묶인다(검증 확정).
    //  성공분은 다음 호출에서 풀 잔량 0 이라 재시도 멱등.
    if (!done.length && failed.length) {
      return NextResponse.json({ ok: false, error: `자동 합류 전건 실패(${failed.length}건)`, failed: failed.length }, { status: 500 });
    }

    // 4) Teams 알림 — 합류 1회 = 게시물 1건
    if (done.length) {
      try {
        const lines = done.map((r) => `- ${nameById.get(r.product_id)?.name || "품목"} ×${r.qty.toLocaleString()}`);
        if (failed.length) lines.push(`(실패 ${failed.length}건: ${failed.join(", ")} — 내일 재시도)`);
        const totalQty = done.reduce((s, r) => s + r.qty, 0);
        const first = nameById.get(done[0].product_id);
        const title = done.length === 1 ? (first?.name || "품목") : `${first?.name || "품목"} 외 ${done.length - 1}종`;
        await logInventoryPoolMoved("프로모션", "소매", title, done.length === 1 ? first?.sku ?? null : null, totalQty, "행사 하루 전 자동 합류", "자동", lines.join("\n"));
      } catch (e) { console.warn("[promotion/release] 알림 실패", e); }
    }

    return NextResponse.json({ ok: true, released: done.length, ...stats, failed: failed.length, held: held.size });
  } catch (err) {
    console.error("[promotion/release]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "자동 합류 실패") }, { status: 500 });
  }
}
