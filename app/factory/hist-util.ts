// 파도소리 기록 표기 — 히스토리 화면과 입고 및 출고 화면이 같이 쓴다(2026-11-27, 히스토리에서 옮김). DB 코드 없음.
import { FIELD_LABEL, KIND_LABEL, boxQty, boxesOf, kgStr, kgNum, lotLabel, type HistEvent } from "@/app/lib/factory";

// KST 월-일 시:분
export const hm = (iso: string | null | undefined) => (iso ? new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "");
const money = (field: string, v: string | null | undefined) =>
  v == null ? "없음" : (field === "cost" || field === "price") && /^\d+$/.test(v) ? `${Number(v).toLocaleString("ko-KR")}원` : v;
// 입력 시각 — 기록일과 같은 날이면 시:분만, 다르면 '월-일 시:분 입력'
export const stamp = (e: HistEvent) => { const s = hm(e.at); return s.slice(0, 5) === e.date.slice(5) ? s.slice(6) : `${s} 입력`; };

// 이벤트 한 줄 설명
export function describe(e: HistEvent): string {
  if (e.kind === "변경") {
    const f = e.field || "";
    if (f === "등록") return `품목 등록${e.new_value ? ` (${e.new_value})` : ""}`;
    if (f === "삭제") return "품목 삭제";
    return `${FIELD_LABEL[f] || f} ${money(f, e.old_value)} → ${money(f, e.new_value)}`;
  }
  const parts = [lotLabel({ mfg_date: e.mfg_date ?? null, box_kg: e.box_kg, storage: e.storage })];
  if (e.txn_kind) parts.unshift(KIND_LABEL[e.txn_kind]);
  if (e.unit_price != null) parts.push(`${e.unit_price.toLocaleString("ko-KR")}원/kg`);
  if (e.txn_type === "조정" && e.target_kg != null && e.kg != null) parts.push(`실사 ${kgStr(e.target_kg)}(이전 ${kgStr(kgNum(e.target_kg - e.kg))})`);
  if (e.partner) parts.push(e.partner);
  if (e.tape_color) parts.push(`테잎 ${e.tape_color}`);
  if (e.vessel) parts.push(`본선 ${e.vessel}`);
  const head = e.kind === "취소" ? `${e.txn_type} 기록 취소 · ` : "";
  return head + parts.join(" · ");
}

// 취소 = 그 기록의 반대 효과(입고 +30kg 취소 → −30kg)
export const qtyKg = (e: HistEvent) => (e.kg == null || e.kind === "변경" ? null : e.kind === "취소" ? -e.kg : e.kg);
// 박스 수 = kg ÷ 로트 박스 중량(부호는 kg 를 따른다)
export const qtyBox = (e: HistEvent) => { const q = qtyKg(e); const b = q == null ? null : boxesOf(Math.abs(q), e.box_kg); return b == null ? null : (q! < 0 ? "−" : "+") + boxQty(b); };
