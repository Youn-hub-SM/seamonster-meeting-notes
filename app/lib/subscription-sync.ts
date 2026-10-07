import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getKv } from "./b2b-settings";
import { computeSubscriptionSnapshot, parseList, DEFAULT_EXCLUDE_NAMES, DEFAULT_EXCLUDE_OPTS } from "./subscription-snapshot";

// 카페24 정기배송 신청 자동 수집(127) — 중계 서버 → /api/subscription/sync → 저장 → /api/subscription/data → 분석 화면.
//  개인정보: 이름·연락처·주소·이메일은 저장하지 않는다. 회원 아이디·신청자/수령자 이름은 받는 즉시 HMAC 으로 바꾼다
//  (되돌릴 수 없음 — 이름 제외·검색은 입력값을 같은 방식으로 바꿔 비교, /api/subscription/hash). 주소는 첫 낱말(시·도)만.
//  서버 전용(node:crypto).

// HMAC 키 — 중계 서버 업로드 공용 시크릿에서 용도별로 파생(새 환경변수 없이). 시크릿이 바뀌면 다음 수집 때 전부 새 값으로 다시 저장된다.
function hashKey(): Buffer {
  const secret = (process.env.NAVER_COMMERCE_CLIENT_SECRET || "").trim();
  if (!secret) throw new Error("NAVER_COMMERCE_CLIENT_SECRET 이 없어 암호화 값을 만들 수 없습니다.");
  return createHmac("sha256", secret).update("subscription-pii-v1").digest();
}
export type HashKind = "member" | "name";
// 같은 값·같은 종류면 늘 같은 결과. 공백만 다듬는다(대시보드의 이름 비교가 trim 후 완전 일치라서).
export function subHash(kind: HashKind, value: unknown, key: Buffer = hashKey()): string | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  return createHmac("sha256", key).update(`${kind}:${v}`).digest("hex").slice(0, 24);
}
export const subHashKey = hashKey;

// ── 중계 서버가 보내는 모양(개인정보는 아이디·이름 원문만 — 저장 전 해시) ──
export type SyncItemIn = {
  subscription_item_id: string | number; product_no?: number | string | null; product_code?: string | null; variant_code?: string | null;
  product_name?: string | null; option_value?: string | null; quantity?: number | string | null;
  subscription_cycle?: string | null; subscription_cycle_count?: number | string | null; subscription_shipments_sequence?: number | string | null;
  subscription_state?: string | null; expected_pay_date?: string | null; expected_delivery_date?: string | null; terminated_date?: string | null;
  max_delivery_limit?: number | string | null;
};
export type SyncSubIn = {
  subscription_id: string; created_date?: string | null; subscription_state?: string | null;
  member_id?: string | null; buyer_name?: string | null; receiver_name?: string | null; region?: string | null;
  items?: SyncItemIn[];
};
export type SyncPaymentIn = { subscription_id: string; order_id: string; status?: string | null; payment_date?: string | null };

const intOrNull = (v: unknown) => { const n = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : Math.trunc(n); };
const numOrNull = (v: unknown) => { const n = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n; };
// 날짜 — 'YYYY-MM-DD' 또는 시각 포함(+09:00 등). 시각이 있으면 KST 날짜로.
export function kstDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  return new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
}
const regionOf = (v: unknown) => String(v ?? "").trim().split(/\s+/)[0]?.slice(0, 20) || null;

export function toSubRow(s: SyncSubIn, runAt: string, key: Buffer) {
  return {
    subscription_id: String(s.subscription_id),
    created_date: kstDate(s.created_date),
    state: s.subscription_state ? String(s.subscription_state).slice(0, 2) : null,
    member_hash: subHash("member", s.member_id, key),
    buyer_name_hash: subHash("name", s.buyer_name, key),
    receiver_name_hash: subHash("name", s.receiver_name, key),
    region: regionOf(s.region),
    synced_at: runAt,
  };
}
export function toItemRows(s: SyncSubIn, runAt: string) {
  return (s.items ?? []).map((it, i) => {
    const cyc = String(it.subscription_cycle ?? "").trim().toUpperCase();
    return {
      subscription_item_id: String(it.subscription_item_id),
      subscription_id: String(s.subscription_id),
      sort: i,
      product_no: intOrNull(it.product_no),
      product_code: it.product_code ?? null,
      variant_code: it.variant_code ?? null,
      product_name: it.product_name ?? null,
      option_value: it.option_value ?? null,
      quantity: numOrNull(it.quantity),
      cycle_unit: cyc ? cyc.slice(0, 1) : null,
      cycle_count: intOrNull(it.subscription_cycle_count),
      sequence: intOrNull(it.subscription_shipments_sequence),
      state: it.subscription_state ? String(it.subscription_state).slice(0, 2) : null,
      expected_pay_date: kstDate(it.expected_pay_date),
      expected_delivery_date: kstDate(it.expected_delivery_date),
      terminated_date: kstDate(it.terminated_date),
      max_delivery_limit: intOrNull(it.max_delivery_limit),
      synced_at: runAt,
    };
  });
}

// ── 분석 화면용 행 — 카페24 관리자 CSV 와 같은 열 이름·표기(대시보드의 기존 계산을 그대로 쓰게) ──
//  CSV 와 맞춘 것: 옵션 구분자 '; '(API 는 ', '), 배송주기 '2주'·'1개월', 상태 문구, 결제예정일·회차는 이용중 줄만(CSV 와 같은 뜻).
//  이름·연락처는 빈칸, 신청자아이디 = 회원 아이디 해시, 수령자주소 = 시·도(대시보드 parseRegion 이 첫 낱말을 지역으로 읽는다).
export const STATE_LABEL: Record<string, string> = {
  U: "이용중",
  B: "일시정지(구매자 신청)",
  Q: "일시정지(관리자 신청)",
  M: "해지(구매자해지)",
  A: "해지(자동해지)",
  O: "해지(관리자 해지)",
};
export function cycleLabel(unit: string | null, count: number | null): string {
  const n = count && count > 0 ? count : 1;
  if (unit === "W") return `${n}주`;
  if (unit === "M") return `${n}개월`;
  if (unit === "Y") return `${n}년`;
  return unit ? `${n}${unit}` : "";
}
// 'a=1, b=2, c=3' → 'a=1; b=2; c=3' — 쉼표 뒤가 '키=' 일 때만 바꾼다(값 안의 쉼표는 그대로)
export const optionToCsv = (opt: string | null) => String(opt ?? "").replace(/,\s*(?=[^,=;]+=)/g, "; ");

export type SubRow = ReturnType<typeof toSubRow>;
export type ItemRow = ReturnType<typeof toItemRows>[number];
export function toDashboardRows(subs: SubRow[], items: ItemRow[]): Record<string, string>[] {
  const bySub = new Map<string, ItemRow[]>();
  for (const it of items) bySub.set(it.subscription_id, [...(bySub.get(it.subscription_id) ?? []), it]);
  const out: Record<string, string>[] = [];
  for (const s of subs) {
    const its = (bySub.get(s.subscription_id) ?? []).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    for (const it of its) {
      const active = it.state === "U";
      out.push({
        "신청번호": s.subscription_id,
        "신청일": s.created_date ?? "",
        "신청자": "",
        "신청자아이디": s.member_hash ?? "",
        "신청자해시": s.buyer_name_hash ?? "",
        "수령자해시": s.receiver_name_hash ?? "",
        "수령자주소": s.region ?? "",
        "상품명": it.product_name ?? "",
        "상품번호": it.product_no != null ? String(it.product_no) : "",
        "옵션": optionToCsv(it.option_value),
        "수량": it.quantity != null ? String(it.quantity) : "",
        "배송주기": cycleLabel(it.cycle_unit, it.cycle_count),
        "정기배송 이용여부": STATE_LABEL[it.state ?? ""] ?? (it.state ?? ""),
        "결제예정일": active ? it.expected_pay_date ?? "" : "",
        "회차": active && it.sequence != null ? String(it.sequence) : "",
        "해지일": it.terminated_date ?? "",
      });
    }
  }
  return out;
}

export const SYNC_KV = "subscription_sync_last"; // { at, subs, items, payments, complete }

// 저장된 신청·품목 전량 → 분석 화면 행(데이터 API·자동 스냅샷 공용). range 페이징 전량(서버 Max Rows 1000).
async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message?: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw error;
    const rows = (data as T[] | null) ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
export async function loadDashboardRows(sb: SupabaseClient): Promise<{ rows: Record<string, string>[]; subs: number }> {
  const [subs, items] = await Promise.all([
    pageAll<SubRow>((a, b) => sb.from("cafe24_subscriptions").select("*").order("subscription_id").range(a, b)),
    pageAll<ItemRow>((a, b) => sb.from("cafe24_subscription_items").select("*").order("subscription_item_id").range(a, b)),
  ]);
  return { rows: toDashboardRows(subs, items), subs: subs.length };
}

// 자동 결과 스냅샷(2026-10-07) — 수집 직후 매일 저장해 분석 히스토리가 끊기지 않게.
//  계산은 화면과 같은 규칙(subscription-snapshot.ts), 필터는 화면 기본값(저장된 '제외 기본값', 없으면 HTML 기본값·관리자 상태 제외).
//  같은 기준일이 이미 있으면 갱신(화면의 '결과 저장'과 같은 규칙 — subscription_snapshots, migration 020).
export async function saveAutoSnapshot(sb: SupabaseClient, asOf: string, complete: boolean): Promise<{ ok: boolean; updated?: boolean; error?: string }> {
  try {
    const { rows } = await loadDashboardRows(sb);
    if (!rows.length) return { ok: false, error: "저장된 신청이 없습니다" };
    let names = DEFAULT_EXCLUDE_NAMES, opts = DEFAULT_EXCLUDE_OPTS;
    try {
      const raw = await getKv("subscription_exclude");
      if (raw) { const v = JSON.parse(raw) as { names?: unknown; opts?: unknown }; if (typeof v.names === "string") names = v.names; if (typeof v.opts === "string") opts = v.opts; }
    } catch { /* 기본값으로 */ }
    const key = hashKey();
    const fileName = `카페24 자동 수집 ${asOf}`;
    const snapshot = {
      ...computeSubscriptionSnapshot({
        rows, dataDate: asOf, fileName,
        excludeNameHashes: parseList(names).map((n) => subHash("name", n, key) ?? "").filter(Boolean),
        excludeOpts: parseList(opts),
      }),
      auto: true,          // 자동 저장(화면에서 누른 저장과 구분)
      complete,            // false = 그날 수집에서 일부 기간을 못 받음
    };
    const { data: existing, error: exErr } = await sb.from("subscription_snapshots").select("id").eq("data_date", asOf).maybeSingle();
    if (exErr) throw exErr;
    if (existing) {
      const { error } = await sb.from("subscription_snapshots").update({ snapshot, file_name: fileName, created_at: new Date().toISOString() }).eq("id", (existing as { id: string }).id);
      if (error) throw error;
      return { ok: true, updated: true };
    }
    const { error } = await sb.from("subscription_snapshots").insert({ data_date: asOf, file_name: fileName, snapshot });
    if (error) throw error;
    return { ok: true, updated: false };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? e) };
  }
}
export const isMissingTable = (e: { message?: string } | null | undefined) => !!e && /cafe24_subscription|does not exist|schema cache/i.test(e.message || "");
