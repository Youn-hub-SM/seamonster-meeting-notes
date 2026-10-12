import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { mirrorB2BTeams } from "@/app/lib/b2b-teams";
import { getKv, setKv } from "@/app/lib/b2b-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/claims/report — 중계 서버 클레임 폴러가 채널별 취소/반품/교환 요청과
//  고객문의(고객문의·상품문의·고객센터문의, 2026-09-17 확장)를 밀어넣는다(112).
//  새 건(중복 아님)만 Teams 로 알림. 같은 건의 재전송은 (channel, claim_key) 유니크로 무시.
//  미들웨어 예외 경로 — Bearer(카탈로그 업로드와 같은 공용 시크릿)로 직접 인증.
//
//  inquiry_log(선택, 2026-10-12 — 주간 종합 리포트 '고객의 소리'): 최근 문의의 질문·답변 대장(137 channel_inquiries).
//  알림과 별개 — (channel, inquiry_key) 로 upsert 해 나중에 달린 답변이 같은 행에 붙는다. 답변 완료는 미답변으로 내리지 않는다.
//  137 미적용이면 조용히 건너뛰고 응답에 inquiry_log: "skipped_137".
//  순서: 알림(삽입 → Teams → notified_at)을 끝낸 뒤에 대장을 처리한다 — 대장이 알림을 늦추거나, 시간 초과로 삽입 뒤
//  발송 전에 끊겨 알림이 사라지지 않게. 폴러도 대장은 claims: [] 인 별도 요청으로 보낸다(알림 요청 본문은 이전과 같다).

const CHANNELS = new Set(["스마트스토어", "쿠팡", "카페24"]);
const TYPES = new Set(["취소", "반품", "교환", "고객문의", "상품문의", "고객센터문의"]);
// 문의 유형 — 게시물 제목·줄 구성이 클레임과 다르다(문의 내용은 reason 필드에 실려 온다)
const INQUIRY_TYPES = new Set(["고객문의", "상품문의", "고객센터문의"]);

function bearerOk(req: NextRequest): boolean {
  const authz = req.headers.get("authorization") || "";
  const keys = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET, process.env.DIGEST_CRON_KEY];
  return keys.some((k) => k && k.trim() && authz === `Bearer ${k.trim()}`);
}

type ClaimIn = {
  claim_type?: string; claim_key?: string; order_id?: string;
  product_name?: string; option_name?: string | null; qty?: number;
  reason?: string | null; status?: string | null; requested_at?: string | null;
  action_required?: boolean; // true=판매자 승인/처리 필요, false=자동 처리 통보. 구 폴러 미전송 시 true 취급
};

// ── 문의 대장(137) ──────────────────────────────────────────────
type InquiryIn = {
  kind?: unknown; inquiry_key?: unknown; product_name?: unknown; category?: unknown; title?: unknown;
  question?: unknown; answer?: unknown; answered?: unknown; asked_at?: unknown; answered_at?: unknown;
};
type InquiryRow = {
  channel: string; kind: string; inquiry_key: string;
  product_name: string | null; category: string | null; title: string | null;
  question: string | null; answer: string | null; answered: boolean;
  asked_at: string | null; answered_at: string | null;
};
type InquiryExisting = Omit<InquiryRow, "channel" | "kind">;
type InquiryLogResult = string | { received: number; written: number; unchanged: number; dropped: number };

const INQUIRY_LOG_KINDS = new Set(["고객문의", "상품문의"]);
const INQUIRY_LOG_MAX = 1000; // 요청 1건 상한 — 폴러는 500건씩 나눠 보낸다
const INQUIRY_TEXT_MAX = 4000; // 질문·답변 본문 상한
const INQUIRY_COLS = "inquiry_key, product_name, category, title, question, answer, answered, asked_at, answered_at";

const isMissing137 = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" ||
    (/channel_inquiries/i.test(e.message || "") && /does not exist|could not find/i.test(e.message || "")));

// 본문 정리 — 답변 템플릿의 HTML 태그·엔티티를 걷어 글만 남기고(리포트 토큰 절약), Postgres 가 거부하는
//  NUL·짝 없는 서로게이트(잘린 이모지)를 지운다. 하나라도 남으면 묶음 upsert 전체가 실패한다.
function cleanText(v: unknown, max: number): string | null {
  if (v == null || typeof v === "object") return null;
  let s = String(v)
    .replace(/\u0000/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<\/?[a-zA-Z][^<>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
  if (s.length > max) s = s.slice(0, max);
  s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "").trim();
  return s || null;
}

// 시각 — 네이버는 오프셋 붙은 ISO 또는 오프셋 없는 KST 문자열을 준다. 오프셋이 없으면 KST(+09:00)로 못박는다
//  (Node 는 오프셋 없는 값을 서버 로컬=UTC 로 읽어 9시간 어긋난다 — 카페24 expires_at 과 같은 함정).
function parseTs(v: unknown): string | null {
  if (v == null || v === "") return null;
  let t: number;
  if (typeof v === "number") {
    t = v;
  } else {
    const m = String(v).trim().match(
      /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i,
    );
    if (!m) return null;
    const [, y, mo, d, h = "0", mi = "00", se = "00", frac = "", tz] = m;
    const p2 = (x: string) => x.padStart(2, "0");
    let off = "+09:00";
    if (tz) {
      if (/^z$/i.test(tz)) off = "Z";
      else { const c = tz.replace(":", ""); off = `${c.slice(0, 3)}:${c.slice(3, 5) || "00"}`; }
    }
    t = Date.parse(`${y}-${p2(mo)}-${p2(d)}T${p2(h)}:${mi}:${p2(se)}.${(frac + "000").slice(0, 3)}${off}`);
  }
  if (!Number.isFinite(t)) return null;
  const iso = new Date(t).toISOString();
  const year = Number(iso.slice(0, 4));
  return year >= 2000 && year <= 2100 ? iso : null;
}

function normalizeInquiry(channel: string, r: InquiryIn): InquiryRow | null {
  if (!r || typeof r !== "object") return null;
  const kind = String(r.kind ?? "");
  const key = String(r.inquiry_key ?? "").trim();
  if (!INQUIRY_LOG_KINDS.has(kind) || !key || key.length > 200) return null;
  const answer = cleanText(r.answer, INQUIRY_TEXT_MAX);
  return {
    channel, kind, inquiry_key: key,
    product_name: cleanText(r.product_name, 300),
    category: cleanText(r.category, 100),
    title: cleanText(r.title, 300),
    question: cleanText(r.question, INQUIRY_TEXT_MAX),
    answer,
    answered: r.answered === true || !!answer,
    asked_at: parseTs(r.asked_at),
    answered_at: parseTs(r.answered_at),
  };
}

const sameTs = (a: string | null, b: string | null) =>
  (a == null && b == null) || (a != null && b != null && Date.parse(a) === Date.parse(b));
// 둘 중 이른 시각 — 답변 시각은 '첫 답변'이라, 답변을 고쳐 채널 쪽 시각이 늦어져도 처음 본 값을 지킨다
const earlierTs = (a: string | null, b: string | null) =>
  a == null ? b : b == null ? a : Date.parse(b) < Date.parse(a) ? b : a;

// 기존 행과 합치기 — 빈 값이 와도 있던 값은 지우지 않고, 답변 완료는 미답변으로 내리지 않는다
function mergeInquiry(ex: InquiryExisting, r: InquiryRow): InquiryRow {
  return {
    ...r,
    product_name: r.product_name ?? ex.product_name,
    category: r.category ?? ex.category,
    title: r.title ?? ex.title,
    question: r.question ?? ex.question,
    answer: r.answer ?? ex.answer,
    answered: r.answered || ex.answered === true,
    asked_at: r.asked_at ?? ex.asked_at,
    answered_at: earlierTs(r.answered_at, ex.answered_at ?? null),
  };
}

function sameInquiry(ex: InquiryExisting, m: InquiryRow): boolean {
  return (ex.product_name ?? null) === m.product_name && (ex.category ?? null) === m.category &&
    (ex.title ?? null) === m.title && (ex.question ?? null) === m.question && (ex.answer ?? null) === m.answer &&
    (ex.answered === true) === m.answered && sameTs(ex.asked_at ?? null, m.asked_at) && sameTs(ex.answered_at ?? null, m.answered_at);
}

// 종류별 '마지막 수집 성공' 시각 — b2b_settings kv(INQUIRY_HB_KEY) = {채널: {고객문의: ISO, 상품문의: ISO}}.
//  폴러가 끝까지 받은 종류(inquiry_log_ok)만, 저장이 성공했을 때만 남긴다. 리포트(report-voice)가 이 값으로
//  '수집이 멈춘 기간'과 '문의가 정말 없던 기간'을 구별한다(대장 updated_at 은 바뀐 행만 갱신돼 생존 신호가 못 된다).
const INQUIRY_HB_KEY = "inquiry_log_heartbeat"; // app/lib/report-voice.ts 와 같은 키(라우트 파일은 이름 있는 export 금지)
async function touchInquiryHeartbeat(channel: string, okRaw: unknown): Promise<void> {
  const kinds = (Array.isArray(okRaw) ? okRaw : []).map(String).filter((k) => INQUIRY_LOG_KINDS.has(k));
  if (!kinds.length) return;
  try {
    let all: Record<string, Record<string, string>> = {};
    try { const j = JSON.parse((await getKv(INQUIRY_HB_KEY)) || "{}"); if (j && typeof j === "object") all = j; } catch { /* 깨진 값은 새로 */ }
    const now = new Date().toISOString();
    all[channel] = { ...(all[channel] || {}), ...Object.fromEntries(kinds.map((k) => [k, now])) };
    await setKv(INQUIRY_HB_KEY, JSON.stringify(all));
  } catch (err) {
    console.error("[claims/report] inquiry_log heartbeat", err);
  }
}

// 대장 저장 — 어떤 실패도 밖으로 던지지 않는다(알림 경로 보호). inquiry_log 가 없으면 null(구 폴러·다른 채널).
async function saveInquiryLog(channel: string, raw: unknown): Promise<InquiryLogResult | null> {
  if (!Array.isArray(raw)) return null;
  try {
    const byKey = new Map<string, InquiryRow>();
    let dropped = Math.max(0, raw.length - INQUIRY_LOG_MAX);
    for (const item of raw.slice(0, INQUIRY_LOG_MAX) as InquiryIn[]) {
      const row = normalizeInquiry(channel, item);
      if (!row) { dropped++; continue; }
      byKey.set(row.inquiry_key, row); // 같은 키 두 번 = 뒤의 것(한 upsert 에 같은 행이 두 번이면 Postgres 오류)
    }
    const rows = [...byKey.values()];

    const sb: SupabaseClient = supabaseAdmin();
    const probe = await sb.from("channel_inquiries").select("id").limit(0);
    if (probe.error) {
      if (isMissing137(probe.error)) return "skipped_137";
      throw probe.error;
    }
    if (!rows.length) return { received: raw.length, written: 0, unchanged: 0, dropped };

    const existing = new Map<string, InquiryExisting>();
    const keys = rows.map((r) => r.inquiry_key);
    for (let i = 0; i < keys.length; i += 100) {
      const { data, error } = await sb.from("channel_inquiries").select(INQUIRY_COLS)
        .eq("channel", channel).in("inquiry_key", keys.slice(i, i + 100));
      if (error) throw error;
      for (const e of (data ?? []) as unknown as InquiryExisting[]) existing.set(e.inquiry_key, e);
    }

    // 새 행·바뀐 행만 쓴다 — 폴러가 10분마다 8일치를 보내므로 그대로 덮으면 updated_at 이 의미를 잃는다
    const now = new Date().toISOString();
    const writes: (InquiryRow & { updated_at: string })[] = [];
    let unchanged = 0;
    for (const r of rows) {
      const ex = existing.get(r.inquiry_key);
      const merged = ex ? mergeInquiry(ex, r) : r;
      if (ex && sameInquiry(ex, merged)) { unchanged++; continue; }
      writes.push({ ...merged, updated_at: now });
    }
    for (let i = 0; i < writes.length; i += 200) {
      const { error } = await sb.from("channel_inquiries")
        .upsert(writes.slice(i, i + 200), { onConflict: "channel,inquiry_key" });
      if (error) throw error;
    }
    return { received: raw.length, written: writes.length, unchanged, dropped };
  } catch (err) {
    console.error("[claims/report] inquiry_log", err);
    return `error: ${extractErrorMsg(err, "문의 대장 저장 실패")}`.slice(0, 300);
  }
}

type Reply = { status: number; json: Record<string, unknown> };

// 알림 경로(112) — 2026-10-12 이전과 같은 동작. 던지지 않고 응답(상태·본문)을 돌려준다(대장 처리를 뒤에 붙이려고).
async function handleClaims(channel: string, raw: unknown): Promise<Reply> {
  try {
    const claims = (Array.isArray(raw) ? (raw as ClaimIn[]) : [])
      .map((c) => ({
        claim_type: TYPES.has(String(c.claim_type)) ? String(c.claim_type) : "",
        claim_key: String(c.claim_key || "").slice(0, 200),
        order_id: String(c.order_id || "").slice(0, 100) || null,
        product_name: String(c.product_name || "").slice(0, 300) || null,
        option_name: c.option_name ? String(c.option_name).slice(0, 300) : null,
        qty: c.qty != null && Number.isFinite(Number(c.qty)) ? Number(c.qty) : null,
        reason: c.reason ? String(c.reason).slice(0, 500) : null,
        status: c.status ? String(c.status).slice(0, 100) : null,
        requested_at: c.requested_at ? String(c.requested_at).slice(0, 40) : null,
        action_required: c.action_required !== false,
      }))
      // 판매자 승인/처리가 필요한 요청만 — 자동 처리된 '통보'성 건은 알림에서 제외(대표 요청 2026-09-12)
      .filter((c) => c.claim_type && c.claim_key && c.action_required);
    if (claims.length === 0) return { status: 200, json: { ok: true, inserted: 0, notified: 0 } };

    const sb = supabaseAdmin();
    const probe = await sb.from("channel_claims").select("id").limit(0);
    if (probe.error) {
      return { status: 503, json: { ok: false, error: "마이그레이션 112(channel_claims) 적용이 필요합니다." } };
    }

    // 새 건만 삽입(유니크 무시 upsert) 후, 이번에 실제로 들어간 행만 조회해 알림 —
    //  폴링 창이 겹쳐 같은 클레임이 여러 번 와도 알림은 정확히 1회.
    const inserted: typeof claims = [];
    for (const c of claims) {
      const { action_required, ...row } = c;
      void action_required;
      const { data, error } = await sb
        .from("channel_claims")
        .upsert({ channel, ...row }, { onConflict: "channel,claim_key", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      if (data && data.length > 0) inserted.push(c);
    }

    // Teams 알림 — 한 폴링분은 한 메시지로 묶는다(클레임 폭주 시 도배 방지).
    //  여기 오는 건 전부 '판매자 승인·처리 필요'(자동 처리 통보·답변 완료 문의는 위에서 제외됨).
    let notified = 0;
    if (inserted.length > 0) {
      const lineOf = (c: (typeof inserted)[number]) =>
        INQUIRY_TYPES.has(c.claim_type)
          ? `- [${c.claim_type}] ${c.product_name ? `${c.product_name} — ` : ""}${(c.reason || "(내용 없음)").slice(0, 120)}${c.order_id ? ` · 주문 ${c.order_id}` : ""}`
          : `- [${c.claim_type}] ${c.product_name || "(상품명 미상)"}${c.option_name ? ` / ${c.option_name}` : ""}${c.qty ? ` x${c.qty}` : ""}` +
            `${c.order_id ? ` · 주문 ${c.order_id}` : ""}${c.reason ? ` · 사유: ${c.reason}` : ""}`;
      // 클레임과 고객문의는 채널이 다르다(2026-09-21 대표 지시) — 섞여 와도 각자 채널로 한 장씩.
      //  폴러는 보통 한 종류씩 보내지만, 한쪽이 비면 그 게시물은 아예 만들지 않는다.
      const groups: { rows: typeof inserted; inquiry: boolean }[] = [
        { rows: inserted.filter((c) => !INQUIRY_TYPES.has(c.claim_type)), inquiry: false },
        { rows: inserted.filter((c) => INQUIRY_TYPES.has(c.claim_type)), inquiry: true },
      ];
      for (const g of groups) {
        if (!g.rows.length) continue;
        const lines = g.rows.slice(0, 15).map(lineOf);
        if (g.rows.length > 15) lines.push(`- 외 ${g.rows.length - 15}건`);
        const kinds = [...new Set(g.rows.map((c) => c.claim_type))];
        const header = g.inquiry
          ? `${channel} 새 고객문의 ${g.rows.length}건 (${kinds.join("/")})`
          : `${channel} 승인·처리 필요 클레임 ${g.rows.length}건 (${kinds.join("/")})`;
        await mirrorB2BTeams(`${header}\n${lines.join("\n")}`, null, null,
          g.inquiry ? { inquiry: true } : { claims: true });
      }
      notified = inserted.length;
      const keys = inserted.map((c) => c.claim_key);
      await sb.from("channel_claims").update({ notified_at: new Date().toISOString() })
        .eq("channel", channel).in("claim_key", keys);
    }

    return { status: 200, json: { ok: true, inserted: inserted.length, notified } };
  } catch (err) {
    console.error("[claims/report]", err);
    return { status: 500, json: { ok: false, error: extractErrorMsg(err, "클레임 접수 실패") } };
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!bearerOk(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { channel?: string; claims?: unknown; inquiry_log?: unknown; inquiry_log_ok?: unknown };
    const channel = String(body.channel || "");
    if (!CHANNELS.has(channel)) {
      return NextResponse.json({ ok: false, error: `허용되지 않은 channel: ${channel}` }, { status: 400 });
    }

    // 알림 먼저 — 삽입 → Teams → notified_at 을 끝낸 뒤에야 대장을 본다(알림 실패여도 대장은 처리).
    const reply = await handleClaims(channel, body.claims);
    // 문의 대장(137) — 절대 던지지 않는다. inquiry_log 가 없는 요청(알림 전용)은 이전과 완전히 같은 응답.
    const inquiryLog = await saveInquiryLog(channel, body.inquiry_log);
    if (inquiryLog != null && typeof inquiryLog === "object") await touchInquiryHeartbeat(channel, body.inquiry_log_ok);
    return NextResponse.json(
      { ...reply.json, ...(inquiryLog != null ? { inquiry_log: inquiryLog } : {}) },
      { status: reply.status },
    );
  } catch (err) {
    console.error("[claims/report]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "클레임 접수 실패") }, { status: 500 });
  }
}
