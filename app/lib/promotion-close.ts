import type { SupabaseClient } from "@supabase/supabase-js";
import { logInventoryPoolMoved } from "@/app/lib/b2b-activity";

// 프로모션 요청서 '마감' = 확보분을 소매로 합류(2026-10-06 대표 결정 — 날짜 기반 자동 마감·합류 크론 폐지).
//  행사 판매는 소매에서 나가므로 행사 판매를 시작할 때 사람이 '마감'을 누르면 그 요청서 품목의 프로모션 재고가 소매로 간다.
//  '취소'(행사 무산)도 같다 — 옛 크론은 취소된 요청서의 확보분도 다음 날 소매로 돌렸다.
//  품목마다 옮기는 양 = 오늘까지의 프로모션 재고 − 같은 품목의 '다른 열린 프로모션 요청서'의 순확보(그 행사 몫은 남긴다, 아래 '남길 몫').
//  배정 없이 옮겨 둔 '기타' 확보분도 함께 합류한다. 기록은 사람의 재고 이동과 같은 모양(채널이동 2행·group_id)이라
//  [재고 이동] 최근 내역에서 취소할 수 있다. 다른 요청서 조회가 실패하면 아무것도 옮기지 않는다(그 행사 몫을 빼앗지 않게).
//
//  이행 기록(2026-10-11 원장 점검 S1·S11): 합류한 양 중 이 요청서 자기 배정분은 그 품목 줄에 음수 연결
//   (production_receipts, inv_txn_id = 합류 출고편)로 남긴다. 그래서 '다시 열기'한 요청서의 이행·잔여가 데이터로
//   순확보(배정 − 합류)가 되고(확보 완료처럼 보이던 착시 제거), 합류 이동을 취소하면 cascade(083)로 함께 원복된다.
//   합류 이동은 source 'promo_close' · source_ref = 요청서 id(131, 미적용이면 메모만)로 남긴다.
//  남길 몫(2026-10-11 재점검): 다른 열린 요청서의 (요청서, 품목)별 이행 순합(배정 + 음수 연결, 0 미만은 0) — 시각이 아니라 데이터로 센다.
//   그 요청서가 전에 마감·취소로 보낸 자기 몫은 음수 연결로 이미 빠져 있고, 그 합류 이동을 취소하면 연결이 cascade 로 함께
//   지워져 몫이 저절로 돌아온다. 음수 연결이 없는 옛 합류가 남은 요청서는 먼저 backfillReleaseReceipts 로 맞추고, 실패하면
//   아무것도 옮기지 않는다(S4). (예전 '합류 총량 빼기'는 '기타'분까지 빼서, '마지막 합류 시각 뒤 배정'은 합류 취소·다시 열기 뒤
//   확보분을 빠뜨려 다른 행사 몫을 빼앗았다.)
//  두 번 실행 막기: 마감·[합류 다시 실행]이 시작 시각(136 promo_release_started_at)을 남기고 70초 안의 두 번째 실행은 막는다(S2).
//  서버 전용(b2b-activity import).
const MARK = "채널이동";
const OPEN = ["요청", "진행중"];
export const PROMO_CLOSE_SOURCE = "promo_close";
export type PromoCloseKind = "마감" | "취소";
export const promoCloseMemo = (reqNo: string, kind: PromoCloseKind = "마감") => `프로모션 ${kind}${reqNo ? ` · ${reqNo}` : ""}`;
export const PROMO_RELEASE_RECEIPT_MEMO = "소매 합류";

export type PromoRelease = {
  moved: { name: string; qty: number }[];
  kept: { name: string; qty: number }[]; // 다른 열린 프로모션 요청서 몫으로 남긴 양
  failed: string[];                      // 이동 기록에 실패한 품목
  unlinked?: string[];                   // 이동은 됐지만 이행(음수 연결) 정리에 실패한 품목 — 다시 열면 확보분이 남은 것처럼 보인다
  error?: string;                        // 조회 실패 — 아무것도 옮기지 않았다
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? e));
const missing131 = (m: string) => /\b(source|source_ref|request_key)\b/i.test(m) && /column|schema cache|could not find|does not exist/i.test(m);
const missingCol = (m: string, col: string) => new RegExp(col, "i").test(m) && /column|schema cache|could not find|does not exist/i.test(m);

// 페이지 끝까지 읽는다(서버 Max Rows 1000 에 잘리면 남길 몫·음수 연결이 틀어진다, S4). 오류는 던진다. 안정 정렬은 호출 쪽에서.
type Page = { data: unknown; error: { message: string } | null };
async function readAll<T>(page: (from: number, to: number) => PromiseLike<Page>): Promise<T[]> {
  const acc: T[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await page(off, off + 999);
    if (error) throw error;
    const chunk = (data ?? []) as T[];
    acc.push(...chunk);
    if (chunk.length < 1000) return acc;
  }
}

export async function releasePromotionOnClose(sb: SupabaseClient, requestId: string, reqNo: string, actor: string | null, kind: PromoCloseKind = "마감"): Promise<PromoRelease> {
  const out: PromoRelease = { moved: [], kept: [], failed: [], unlinked: [] };
  try {
    const { data: its, error: ie } = await sb.from("production_request_items").select("id, product_id").eq("request_id", requestId).limit(2000);
    if (ie) throw ie;
    const ownItems = (its ?? []).map((x) => ({ id: String(x.id), pid: String(x.product_id) }));
    const pids = [...new Set(ownItems.map((x) => x.pid))];
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

    if (![...poolQty.values()].some((q) => q > 0)) return out; // 옮길 것 없음 — 다른 요청서 조회·정리도 필요 없다

    // 같은 품목의 다른 열린 프로모션 요청서(= 그 행사 몫) — range 페이징 전량(서버 Max Rows 1000 에 잘리면 남길 몫을 빼앗는다)
    type OtherItem = { pid: string; rid: string };
    type OtherRow = { id: string; product_id: string; request_id: string; production_requests?: { req_no?: string | null } | { req_no?: string | null }[] | null };
    const otherOf = new Map<string, OtherItem>(); // item id → 품목·요청서
    const otherReq = new Map<string, string>();   // 요청서 id → 번호
    const others = await readAll<OtherRow>((from, to) => sb.from("production_request_items")
      .select("id, product_id, request_id, production_requests!inner(purpose, status, req_no)")
      .in("product_id", pids).neq("request_id", requestId)
      .eq("production_requests.purpose", "프로모션").in("production_requests.status", OPEN)
      .order("id", { ascending: true }).range(from, to));
    for (const x of others) {
      otherOf.set(String(x.id), { pid: String(x.product_id), rid: String(x.request_id) });
      const h = Array.isArray(x.production_requests) ? x.production_requests[0] : x.production_requests;
      if (!otherReq.has(String(x.request_id))) otherReq.set(String(x.request_id), String(h?.req_no ?? ""));
    }
    // 옛 합류(음수 연결 없음)가 남은 다시 연 요청서는 먼저 데이터로 맞춘다 — 못 맞추면 그 몫을 셀 수 없으니 아무것도 옮기지 않는다(S4)
    for (const [rid, no] of otherReq) {
      if (!(await backfillReleaseReceipts(sb, rid, no)).ok) throw new Error(`다른 열린 요청서 ${no || "(번호 없음)"}의 예전 합류 기록 확인 실패`);
    }
    // 남길 몫 = (요청서, 품목)별 이행 순합(배정 + 음수 연결). 0 미만은 0.
    const netBy = new Map<string, number>(); // `${요청서}|${품목}` → 순합
    const itemIds = [...otherOf.keys()];
    for (let i = 0; i < itemIds.length; i += 100) {
      const part = itemIds.slice(i, i + 100);
      const rcs = await readAll<{ item_id: string; qty: unknown }>((from, to) => sb.from("production_receipts").select("item_id, qty").in("item_id", part)
        .order("id", { ascending: true }).range(from, to));
      for (const rc of rcs) {
        const o = otherOf.get(String(rc.item_id));
        if (!o) continue;
        const k = `${o.rid}|${o.pid}`;
        netBy.set(k, (netBy.get(k) || 0) + (Number(rc.qty) || 0));
      }
    }
    const keepQty = new Map<string, number>();
    for (const [k, q] of netBy) {
      const pid = k.split("|")[1];
      keepQty.set(pid, (keepQty.get(pid) || 0) + Math.max(0, r2(q)));
    }

    // 이 요청서 자기 배정(품목 줄별 순합) — 합류한 양 중 자기 몫을 음수 연결로 남기는 데 쓴다
    const ownNet = new Map<string, number>(); // item id → 순합
    {
      const ids = ownItems.map((x) => x.id);
      for (let i = 0; i < ids.length; i += 100) {
        for (let off = 0; ; off += 1000) {
          const { data, error } = await sb.from("production_receipts").select("item_id, qty").in("item_id", ids.slice(i, i + 100))
            .order("id", { ascending: true }).range(off, off + 999);
          if (error) throw error;
          for (const rc of data ?? []) ownNet.set(String(rc.item_id), (ownNet.get(String(rc.item_id)) || 0) + (Number(rc.qty) || 0));
          if ((data ?? []).length < 1000) break;
        }
      }
    }

    const { data: prods } = await sb.from("products").select("id, name, sku").in("id", pids);
    const info = new Map((prods ?? []).map((p) => [String(p.id), { name: String(p.name || "품목"), sku: (p.sku as string | null) ?? null }]));
    const memo = promoCloseMemo(reqNo, kind);
    const done: { pid: string; qty: number }[] = [];
    let use131 = true;
    for (const pid of pids) {
      const have = r2(poolQty.get(pid) || 0);
      if (have <= 0) continue;
      const keep = r2(Math.min(have, Math.max(0, keepQty.get(pid) || 0)));
      const qty = r2(have - keep);
      const name = info.get(pid)?.name || "품목";
      if (keep > 0) out.kept.push({ name, qty: keep });
      if (qty <= 0) continue;
      const group_id = crypto.randomUUID();
      const legs = () => {
        const base = { product_id: pid, partner: MARK, memo, group_id, txn_date: today, status: "완료", created_by: actor || "마감",
          ...(use131 ? { source: PROMO_CLOSE_SOURCE, source_ref: requestId } : {}) };
        return [
          { ...base, type: "출고", qty: -qty, channel: "프로모션", unit_amount: null },
          { ...base, type: "입고", qty, channel: "소매", unit_amount: null },
        ];
      };
      let ins = await sb.from("inventory_txns").insert(legs()).select("id, type");
      if (ins.error && use131 && missing131(ins.error.message)) { use131 = false; ins = await sb.from("inventory_txns").insert(legs()).select("id, type"); }
      if (ins.error) { console.warn("[promotion-close] 이동 기록 실패", ins.error.message); out.failed.push(name); continue; }
      out.moved.push({ name, qty });
      done.push({ pid, qty });

      // 자기 몫 음수 연결 — 합류 출고편에 묶어 둔다(이동 취소 시 cascade 원복). 줄별 순합 한도 안에서 나눈다.
      const outId = (ins.data ?? []).find((t) => t.type === "출고")?.id as string | undefined;
      let rest = qty;
      const negRows: Record<string, unknown>[] = [];
      for (const it of ownItems.filter((x) => x.pid === pid)) {
        const net = r2(ownNet.get(it.id) || 0);
        const take = r2(Math.min(rest, net));
        if (take <= 0) continue;
        negRows.push({ request_id: requestId, item_id: it.id, qty: -take, memo: `${PROMO_RELEASE_RECEIPT_MEMO}(${kind})`, received_by: actor, inv_txn_id: outId ?? null, receipt_date: today });
        rest = r2(rest - take);
        if (rest <= 0) break;
      }
      if (negRows.length && outId) {
        const { error: ne } = await sb.from("production_receipts").upsert(negRows, { onConflict: "item_id,inv_txn_id", ignoreDuplicates: true });
        if (ne) { console.warn("[promotion-close] 이행 정리 실패", ne.message); out.unlinked!.push(name); }
      } else if (negRows.length) out.unlinked!.push(name);
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

// 합류 완료 표시(136) — 실패 없이 끝났을 때만 채운다. 실행 클레임도 함께 푼다(끝난 뒤 곧바로 다시 열고 마감해도 막히지 않게).
//  미적용이면 조용히 넘어간다(종전 동작). 시작 시각 칸만 없으면 그 칸 없이 다시 쓴다.
export async function markPromoReleased(sb: SupabaseClient, requestId: string): Promise<void> {
  const at = new Date().toISOString();
  let { error } = await sb.from("production_requests").update({ promo_released_at: at, promo_release_started_at: null }).eq("id", requestId);
  if (error && missingCol(error.message, "promo_release_started_at")) ({ error } = await sb.from("production_requests").update({ promo_released_at: at }).eq("id", requestId));
  if (error && !missingCol(error.message, "promo_released_at")) console.warn("[promotion-close] 합류 완료 표시 실패", error.message);
}

// '다시 열기' 전 확인용 — 이 요청서의 마감·취소로 소매에 넘어간 양(지금 원장에 남아 있는 합류 입고편 합). 조회 실패는 null.
export async function promoReleasedQty(sb: SupabaseClient, requestId: string, reqNo: string): Promise<number | null> {
  try {
    const seen = new Set<string>();
    let total = 0;
    const add = (rows: { id: unknown; qty: unknown }[] | null) => { for (const t of rows ?? []) { const k = String(t.id); if (seen.has(k)) continue; seen.add(k); total += Number(t.qty) || 0; } };
    if (reqNo) {
      const { data, error } = await sb.from("inventory_txns").select("id, qty")
        .eq("partner", MARK).eq("type", "입고").eq("channel", "소매").in("memo", [promoCloseMemo(reqNo, "마감"), promoCloseMemo(reqNo, "취소")]).limit(5000);
      if (error) return null;
      add(data);
    }
    const { data, error } = await sb.from("inventory_txns").select("id, qty").eq("source", PROMO_CLOSE_SOURCE).eq("source_ref", requestId).eq("type", "입고").limit(5000);
    if (error && !missing131(error.message)) return null;
    if (!error) add(data);
    return r2(total);
  } catch { return null; }
}

// 다시 연 요청서의 옛 합류(이 정리 전에 마감된 것·음수 연결에 실패한 것 — 음수 연결 없음)를 데이터로 맞춘다: 합류 출고편마다
//  '그 합류 시각 전에 이 줄에 있던 확보분' 한도 안에서 음수 연결을 남긴다. 합류 뒤(다시 연 뒤)에 새로 배정한 양은 그 합류가
//  가져간 것이 아니므로 빼지 않는다. 이미 있으면(유니크 충돌) 건너뛴다 — 여러 번 불러도 같다.
//  다시 열기에서는 실패해도 막지 않고(경고만), 다른 요청서 마감의 남길 몫 계산에서는 실패하면 합류를 멈춘다(위).
export async function backfillReleaseReceipts(sb: SupabaseClient, requestId: string, reqNo: string): Promise<{ ok: boolean }> {
  try {
    const { data: its, error: ie } = await sb.from("production_request_items").select("id, product_id").eq("request_id", requestId).limit(2000);
    if (ie) return { ok: false };
    const items = (its ?? []).map((x) => ({ id: String(x.id), pid: String(x.product_id) }));
    if (!items.length) return { ok: true };
    type Leg = { id: string; product_id: string; qty: unknown; created_at: string };
    const legs = new Map<string, Leg>();
    if (reqNo) {
      const byMemo = await readAll<Leg>((from, to) => sb.from("inventory_txns").select("id, product_id, qty, created_at")
        .eq("partner", MARK).eq("type", "출고").eq("channel", "프로모션").in("memo", [promoCloseMemo(reqNo, "마감"), promoCloseMemo(reqNo, "취소")])
        .order("id", { ascending: true }).range(from, to));
      for (const t of byMemo) legs.set(String(t.id), t);
    }
    try {
      const bySource = await readAll<Leg>((from, to) => sb.from("inventory_txns").select("id, product_id, qty, created_at")
        .eq("source", PROMO_CLOSE_SOURCE).eq("source_ref", requestId).eq("type", "출고")
        .order("id", { ascending: true }).range(from, to));
      for (const t of bySource) legs.set(String(t.id), t);
    } catch (e) { if (!missing131(errMsg(e))) throw e; } // 131 미적용 — 메모로 찾은 것만
    if (!legs.size) return { ok: true };
    type Rc = { item_id: string; qty: unknown; inv_txn_id: string | null; created_at: string };
    const rcs: Rc[] = [];
    const ids = items.map((x) => x.id);
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      rcs.push(...await readAll<Rc>((from, to) => sb.from("production_receipts").select("item_id, qty, inv_txn_id, created_at").in("item_id", part)
        .order("id", { ascending: true }).range(from, to)));
    }
    const linkedLegs = new Set(rcs.filter((rc) => rc.inv_txn_id).map((rc) => String(rc.inv_txn_id)));
    // 기록 시각 — 음수 연결은 그 합류 출고편의 시각(나중에 채운 연결도 그 합류 때 빠진 것)
    const tOf = (rc: Rc) => Date.parse((rc.inv_txn_id && legs.get(String(rc.inv_txn_id))?.created_at) || rc.created_at);
    const taken = new Map<string, number>(); // 줄 id → 이번에 앞 합류들에 나눈 양
    const rows: Record<string, unknown>[] = [];
    for (const leg of [...legs.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
      if (linkedLegs.has(leg.id)) continue;
      const t = Date.parse(leg.created_at);
      let rest = r2(Math.abs(Number(leg.qty) || 0));
      for (const it of items.filter((x) => x.pid === String(leg.product_id))) {
        const before = rcs.filter((rc) => String(rc.item_id) === it.id && tOf(rc) < t).reduce((sum, rc) => sum + (Number(rc.qty) || 0), 0);
        const take = r2(Math.min(rest, before - (taken.get(it.id) || 0)));
        if (take <= 0) continue;
        rows.push({ request_id: requestId, item_id: it.id, qty: -take, memo: `${PROMO_RELEASE_RECEIPT_MEMO}(이전 마감)`, received_by: "시스템", inv_txn_id: leg.id, receipt_date: new Date(t + 9 * 3600e3).toISOString().slice(0, 10) });
        taken.set(it.id, r2((taken.get(it.id) || 0) + take));
        rest = r2(rest - take);
        if (rest <= 0) break;
      }
    }
    if (!rows.length) return { ok: true };
    const { error } = await sb.from("production_receipts").upsert(rows, { onConflict: "item_id,inv_txn_id", ignoreDuplicates: true });
    return { ok: !error };
  } catch { return { ok: false }; }
}

// 합류 실행 클레임(136 promo_release_started_at) — 마감 응답이 끊겨 서버가 아직 합류 중일 때 [합류 다시 실행]을 누르거나
//  두 사람이 함께 누르면 같은 풀을 두 번 옮긴다(소매 재고 부풂, S2). 시작 시각을 남기고 70초(이 라우트 최대 실행 60초 + 여유)
//  안의 두 번째 실행은 막는다. 'unsupported' = 칸 미적용(종전 동작).
export const PROMO_RELEASE_CLAIM_MS = 70_000;
export const promoClaimFilter = (nowMs = Date.now()) =>
  `promo_release_started_at.is.null,promo_release_started_at.lt."${new Date(nowMs - PROMO_RELEASE_CLAIM_MS).toISOString()}"`;
export async function claimPromoRelease(sb: SupabaseClient, requestId: string, startedAt: string): Promise<"ok" | "busy" | "unsupported"> {
  const { data, error } = await sb.from("production_requests").update({ promo_release_started_at: startedAt })
    .eq("id", requestId).in("status", ["완료", "취소"]).is("promo_released_at", null)
    .or(promoClaimFilter(Date.parse(startedAt))).select("id");
  if (error) { if (missingCol(error.message, "promo_release_started_at")) return "unsupported"; throw error; }
  return (data ?? []).length ? "ok" : "busy";
}
