import type { SupabaseClient } from "@supabase/supabase-js";
import { logInventoryPoolMoved } from "@/app/lib/b2b-activity";

// 프로모션 요청서 '마감' = 확보분을 소매로 합류(2026-10-06 대표 결정 — 날짜 기반 자동 마감·합류 크론 폐지).
//  행사 판매는 소매에서 나가므로 행사 판매를 시작할 때 사람이 '마감'을 누르면 그 요청서 품목의 프로모션 재고가 소매로 간다.
//  '취소'(행사 무산)도 같다 — 옛 크론은 취소된 요청서의 확보분도 다음 날 소매로 돌렸다.
//  품목마다 옮기는 양 = 오늘까지의 프로모션 재고 − 같은 품목의 '다른 열린 프로모션 요청서'에 배정된 수량(그 행사 몫은 남긴다).
//  배정 없이 옮겨 둔 '기타' 확보분도 함께 합류한다. 기록은 사람의 재고 이동과 같은 모양(채널이동 2행·group_id)이라
//  [재고 이동] 최근 내역에서 취소할 수 있다. 다른 요청서 조회가 실패하면 아무것도 옮기지 않는다(그 행사 몫을 빼앗지 않게).
//  서버 전용(b2b-activity import).
const MARK = "채널이동";
const OPEN = ["요청", "진행중"];
export type PromoCloseKind = "마감" | "취소";
export const promoCloseMemo = (reqNo: string, kind: PromoCloseKind = "마감") => `프로모션 ${kind}${reqNo ? ` · ${reqNo}` : ""}`;

export type PromoRelease = {
  moved: { name: string; qty: number }[];
  kept: { name: string; qty: number }[]; // 다른 열린 프로모션 요청서 몫으로 남긴 양
  failed: string[];                      // 이동 기록에 실패한 품목
  error?: string;                        // 조회 실패 — 아무것도 옮기지 않았다
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? e));

export async function releasePromotionOnClose(sb: SupabaseClient, requestId: string, reqNo: string, actor: string | null, kind: PromoCloseKind = "마감"): Promise<PromoRelease> {
  const out: PromoRelease = { moved: [], kept: [], failed: [] };
  try {
    const { data: its, error: ie } = await sb.from("production_request_items").select("product_id").eq("request_id", requestId).limit(2000);
    if (ie) throw ie;
    const pids = [...new Set((its ?? []).map((x) => String(x.product_id)))];
    if (!pids.length) return out;
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // KST

    // 옮길 수 있는 풀 = min(전체 잔량, 오늘까지 잔량) — 미래 날짜로 기록된 들어옴은 아직 없는 물건이고,
    //  미래 날짜로 기록된 나감(예정 출고)은 그만큼 남겨 둬야 한다(옛 크론과 같은 규칙, 감사 #64).
    const [poolAll, poolToday] = await Promise.all([
      sb.rpc("inventory_stock", { asof: null, chan: "프로모션" }).in("product_id", pids),
      sb.rpc("inventory_stock", { asof: today, chan: "프로모션" }).in("product_id", pids),
    ]);
    if (poolAll.error) throw poolAll.error;
    if (poolToday.error) throw poolToday.error;
    const qtyMap = (d: unknown) => new Map(((d as { product_id: string; qty: unknown }[] | null) ?? []).map((r) => [String(r.product_id), Number(r.qty) || 0]));
    const allQ = qtyMap(poolAll.data), todayQ = qtyMap(poolToday.data);
    const poolQty = new Map(pids.map((pid) => [pid, Math.min(allQ.get(pid) || 0, todayQ.get(pid) || 0)]));

    // 같은 품목의 다른 열린 프로모션 요청서 배정(= 그 행사 몫) — range 페이징 전량(서버 Max Rows 1000 에 잘리면 남길 몫을 빼앗는다)
    type OtherItem = { pid: string; rid: string };
    const otherOf = new Map<string, OtherItem>(); // item id → 품목·요청서
    const otherReqNo = new Map<string, string>(); // 요청서 id → 번호(그 요청서가 전에 마감·취소로 이미 합류한 몫을 찾는 데)
    for (let off = 0; ; off += 1000) {
      const { data, error } = await sb.from("production_request_items")
        .select("id, product_id, request_id, production_requests!inner(purpose, status, req_no)")
        .in("product_id", pids).neq("request_id", requestId)
        .eq("production_requests.purpose", "프로모션").in("production_requests.status", OPEN)
        .order("id", { ascending: true }).range(off, off + 999);
      if (error) throw error;
      for (const x of data ?? []) {
        otherOf.set(String(x.id), { pid: String(x.product_id), rid: String(x.request_id) });
        const rel = (x as { production_requests?: { req_no?: string | null } | { req_no?: string | null }[] }).production_requests;
        const h = Array.isArray(rel) ? rel[0] : rel;
        if (h?.req_no) otherReqNo.set(String(x.request_id), String(h.req_no));
      }
      if ((data ?? []).length < 1000) break;
    }
    const allocBy = new Map<string, number>(); // `${요청서}|${품목}` → 배정 합
    const itemIds = [...otherOf.keys()];
    for (let i = 0; i < itemIds.length; i += 100) {
      const part = itemIds.slice(i, i + 100);
      for (let off = 0; ; off += 1000) {
        const { data, error } = await sb.from("production_receipts").select("item_id, qty").in("item_id", part)
          .order("id", { ascending: true }).range(off, off + 999);
        if (error) throw error;
        for (const rc of data ?? []) {
          const o = otherOf.get(String(rc.item_id));
          if (o) allocBy.set(`${o.rid}|${o.pid}`, (allocBy.get(`${o.rid}|${o.pid}`) || 0) + (Number(rc.qty) || 0));
        }
        if ((data ?? []).length < 1000) break;
      }
    }
    //  마감·취소 뒤 '다시 열기'한 요청서는 배정 기록이 그대로 남지만 그 물건은 이미 소매에 있다 — 그 요청서가 합류시킨 양을 빼고 남긴다
    //  (빼지 않으면 그 몫만큼 다른 행사의 확보분이 엉뚱하게 묶인다).
    const releasedBy = new Map<string, number>();
    const memoToRid = new Map<string, string>();
    for (const [rid, no] of otherReqNo) for (const k of ["마감", "취소"] as const) memoToRid.set(promoCloseMemo(no, k), rid);
    const memos = [...memoToRid.keys()];
    for (let i = 0; i < memos.length; i += 50) {
      const { data, error } = await sb.from("inventory_txns").select("product_id, qty, memo")
        .eq("partner", MARK).eq("type", "입고").eq("channel", "소매").in("memo", memos.slice(i, i + 50)).in("product_id", pids).limit(5000);
      if (error) throw error;
      for (const t of data ?? []) {
        const rid = memoToRid.get(String(t.memo));
        if (rid) releasedBy.set(`${rid}|${t.product_id}`, (releasedBy.get(`${rid}|${t.product_id}`) || 0) + (Number(t.qty) || 0));
      }
    }
    const keepQty = new Map<string, number>();
    for (const [k, q] of allocBy) {
      const pid = k.split("|")[1];
      keepQty.set(pid, (keepQty.get(pid) || 0) + Math.max(0, q - (releasedBy.get(k) || 0)));
    }

    const { data: prods } = await sb.from("products").select("id, name, sku").in("id", pids);
    const info = new Map((prods ?? []).map((p) => [String(p.id), { name: String(p.name || "품목"), sku: (p.sku as string | null) ?? null }]));
    const memo = promoCloseMemo(reqNo, kind);
    const done: { pid: string; qty: number }[] = [];
    for (const pid of pids) {
      const have = r2(poolQty.get(pid) || 0);
      if (have <= 0) continue;
      const keep = r2(Math.min(have, Math.max(0, keepQty.get(pid) || 0)));
      const qty = r2(have - keep);
      const name = info.get(pid)?.name || "품목";
      if (keep > 0) out.kept.push({ name, qty: keep });
      if (qty <= 0) continue;
      const base = { product_id: pid, partner: MARK, memo, group_id: crypto.randomUUID(), txn_date: today, status: "완료", created_by: actor || "마감" };
      const { error } = await sb.from("inventory_txns").insert([
        { ...base, type: "출고", qty: -qty, channel: "프로모션", unit_amount: null },
        { ...base, type: "입고", qty, channel: "소매", unit_amount: null },
      ]);
      if (error) { console.warn("[promotion-close] 이동 기록 실패", error.message); out.failed.push(name); continue; }
      out.moved.push({ name, qty });
      done.push({ pid, qty });
    }

    // 알림 — 마감 1회 = 게시물 1건(사람의 프로모션 → 소매 이동과 같은 이벤트)
    if (done.length) {
      try {
        const lines = [
          `요청서 ${reqNo || "(번호 없음)"} ${kind} — 프로모션 → 소매`,
          ...out.moved.map((m) => `- ${m.name} ×${m.qty.toLocaleString()}`),
          ...(out.kept.length ? ["다른 열린 프로모션 요청서 몫으로 남김:", ...out.kept.map((k) => `- ${k.name} ×${k.qty.toLocaleString()}`)] : []),
          ...(out.failed.length ? [`실패: ${out.failed.join(", ")} — '재고 이동'에서 직접 옮기세요`] : []),
        ];
        const first = info.get(done[0].pid);
        const title = done.length === 1 ? (first?.name || "품목") : `${first?.name || "품목"} 외 ${done.length - 1}종`;
        const total = r2(done.reduce((s, d) => s + d.qty, 0));
        await logInventoryPoolMoved("프로모션", "소매", title, done.length === 1 ? first?.sku ?? null : null, total, memo, actor, lines.join("\n"));
      } catch (e) { console.warn("[promotion-close] 알림 실패", e); }
    }
    return out;
  } catch (e) {
    return { ...out, error: errMsg(e) };
  }
}
