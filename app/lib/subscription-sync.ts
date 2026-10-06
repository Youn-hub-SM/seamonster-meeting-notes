import { createHmac } from "node:crypto";

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
export const isMissingTable = (e: { message?: string } | null | undefined) => !!e && /cafe24_subscription|does not exist|schema cache/i.test(e.message || "");
