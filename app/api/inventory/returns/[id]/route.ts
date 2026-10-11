import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { isMissing131, loadByRequestKey, lockKindOf, type LedgerMark } from "../../txn/ledger-write";

export const dynamic = "force-dynamic";

type Sb = ReturnType<typeof supabaseAdmin>;
type Row = Record<string, unknown>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON = "제조사 반품";

// 이 반품의 [재고에서도 빼기] 출고 — 반품 창이 반품 id 를 제출 키로 보낸다(실사 뒤 묶음은 '<id>-held', 엑셀 반영도 반품마다 따로).
//  원장 행 request_key = '<키>:<순번>'(131). 131 미적용이면 키가 없어 찾을 수 없다(missing131). 조회 실패는 error(S4).
async function keyedOutflows(sb: Sb, id: string): Promise<{ rows: Row[]; missing131: boolean; error: string | null }> {
  const rows: Row[] = [];
  for (const key of [id, `${id}-held`]) {
    const r = await loadByRequestKey<Row>(sb, key, "*");
    if (r.error) return isMissing131({ message: r.error }) ? { rows: [], missing131: true, error: null } : { rows, missing131: false, error: r.error };
    rows.push(...r.rows);
  }
  return { rows, missing131: false, error: null };
}

// 키로 못 찾는 출고(131 미적용, 키를 반품마다 두기 전 엑셀 일괄, [입고 및 출고]에서 직접 넣은 것) — 같은 품목·같은 날 사유 '제조사 반품' 출고 중
//  다른 반품의 키로 남은 것을 뺀 나머지. 이 반품 것인지 확신할 수 없어 지우지 않고 알리기만 한다. 사유 칸(099) 미적용이면 unknown.
async function maybeOutflows(sb: Sb, id: string, productId: string, date: string): Promise<{ rows: Row[]; unknown: boolean; error: string | null }> {
  const { data, error } = await sb.from("inventory_txns").select("*")
    .eq("type", "출고").eq("reason", REASON).eq("product_id", productId).eq("txn_date", date).limit(200);
  if (error) {
    if (/reason/i.test(error.message) && /does not exist|could not find|schema cache/i.test(error.message)) return { rows: [], unknown: true, error: null };
    return { rows: [], unknown: false, error: error.message };
  }
  const prefixOf = (r: Row) => String(r.request_key ?? "").split(":")[0].replace(/-held$/, "");
  const cand = (data ?? []).filter((r) => prefixOf(r) !== id) as Row[];
  const prefixes = [...new Set(cand.map(prefixOf).filter((p) => UUID_RE.test(p)))];
  const live = new Set<string>();
  for (let i = 0; i < prefixes.length; i += 100) {
    const { data: pr, error: pe } = await sb.from("purchase_returns").select("id").in("id", prefixes.slice(i, i + 100));
    if (pe) return { rows: [], unknown: false, error: pe.message };
    for (const p of pr ?? []) live.add(String(p.id));
  }
  return { rows: cand.filter((r) => !live.has(prefixOf(r))), unknown: false, error: null };
}

// 이 출고 뒤에 입력된 같은 품목·같은 칸 실사(조정) — 실사일이 출고일 이후(그날 포함)이고 출고보다 나중에 입력됐으면
//  그 실사는 이 출고가 들어간 장부로 차이를 계산했다(조정 = 센 수량 − 그날 장부 재고). 출고를 지우면 재고가 그만큼 실물보다 많아진다(S8).
//  132 return_after_count(출고보다 먼저 입력된 실사)와 반대 방향. 원장 행은 이미 구성품으로 전개돼 있어 행의 품목을 그대로 본다.
//  가장 늦은 실사일을 돌려준다(없으면 null). 조회 실패는 error — '실사 없음'으로 보고 지우지 않는다(S4).
async function countedAfter(sb: Sb, rows: Row[]): Promise<{ date: string | null; error: string | null }> {
  let latest: string | null = null;
  const seen = new Set<string>();
  for (const r of rows) {
    const pid = String(r.product_id || ""), d = String(r.txn_date || "").slice(0, 10);
    const ch = r.channel == null ? null : String(r.channel), at = r.created_at == null ? null : String(r.created_at);
    const k = `${pid}|${ch}|${d}|${at}`;
    if (!pid || !d || seen.has(k)) continue;
    seen.add(k);
    let q = sb.from("inventory_txns").select("txn_date").eq("type", "조정").eq("product_id", pid).gte("txn_date", d);
    if (ch) q = q.eq("channel", ch); // 036 미적용(칸 없음)이면 칸 구분 없이 본다
    if (at) q = q.gt("created_at", at); // 입력 시각을 모르면 출고일 이후 실사를 모두 본다(보수적)
    const { data, error } = await q.order("txn_date", { ascending: false }).limit(1);
    if (error) return { date: null, error: error.message };
    const cd = data?.[0]?.txn_date ? String(data[0].txn_date).slice(0, 10) : null;
    if (cd && (!latest || cd > latest)) latest = cd;
  }
  return { date: latest, error: null };
}

const ordersOf = (rows: Row[]) => {
  const nos = [...new Set(rows.map((r) => String(r.order_no || "")).filter(Boolean))];
  return nos.length ? `${nos.slice(0, 3).join(", ")}${nos.length > 3 ? ` 외 ${nos.length - 3}건` : ""}` : `${rows.length}건`;
};
const FAIL = "이 반품으로 재고에서 뺀 출고가 있는지 확인하지 못했습니다 — 잠시 뒤 다시 시도하세요.";

// DELETE /api/inventory/returns/[id]?confirm=1|keep — 잘못 넣은 반품 기록 삭제.
//  반품 기록은 매입 결산만 깎지만 [재고에서도 빼기]가 남긴 소매 출고(사유 제조사 반품)가 딸려 있을 수 있다(D4c).
//  반품만 지우면 그 출고가 주인 없이 남고, 다시 입력해 또 빼면 이중 차감이다 — 출고가 있으면 409(code 'return_has_outflow' + confirm 문구),
//  confirm=1 이면 그 출고를 먼저 취소(원장에서 삭제 = 재고 원복)한 뒤 반품을 지운다. 출고 먼저 — 반품 삭제가 실패해도 '출고 없는 반품'으로 원장 점검에 잡힌다.
//  단, 그 출고 뒤에 입력된 실사가 있으면 실사가 이미 출고를 반영했다 — 출고를 지우면 재고가 부푼다. 그때는 출고를 지우지 않고
//  409(code 'return_outflow_counted'), confirm=keep 이면 반품만 지운다(출고·실사 그대로, 다시 입력하면 [재고에서도 빼기]는 건너뛴다).
//  키로 못 찾는 같은 날·같은 품목 출고는 지우지 않고 409(code 'return_maybe_outflow'), confirm=keep 이면 반품만 지운다. 조회 실패는 503(S4).
//  409 마다 confirm_as = 확인했을 때 다시 보낼 confirm 값 — 확인 사이에 상황이 바뀌면 다른 409 가 다시 온다.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "잘못된 반품 id 입니다." }, { status: 400 });
    const mode = req.nextUrl.searchParams.get("confirm"); // "1" = 출고도 함께 취소, "keep" = 반품만(출고는 그대로)
    const sb = supabaseAdmin();

    const { data: ret, error: re } = await sb.from("purchase_returns").select("id, product_id, return_date").eq("id", id).maybeSingle();
    if (re) throw re;
    if (!ret) return NextResponse.json({ ok: false, error: "이미 지워진 반품입니다 — 새로고침하세요." }, { status: 404 });
    const productId = String(ret.product_id), date = String(ret.return_date).slice(0, 10);

    const keyed = await keyedOutflows(sb, id);
    if (keyed.error) return NextResponse.json({ ok: false, error: FAIL }, { status: 503 });
    const maybe = keyed.rows.length ? { rows: [] as Row[], unknown: false, error: null } : await maybeOutflows(sb, id, productId, date);
    if (maybe.error) return NextResponse.json({ ok: false, error: FAIL }, { status: 503 });

    let canceled: Row[] = []; // 함께 취소한 출고(confirm=1)
    let kept: Row[] = [];     // 실사에 반영돼 그대로 둔 출고(confirm=keep)
    let keptAt = "";
    if (keyed.rows.length) {
      const list = ordersOf(keyed.rows);
      const counted = await countedAfter(sb, keyed.rows);
      if (counted.error) return NextResponse.json({ ok: false, error: "이 반품의 출고 뒤에 실사가 있었는지 확인하지 못했습니다 — 잠시 뒤 다시 시도하세요." }, { status: 503 });
      if (counted.date) {
        const md = counted.date.slice(5);
        if (mode !== "keep") return NextResponse.json({
          ok: false, code: "return_outflow_counted", orders: list, count_date: counted.date, confirm_as: "keep",
          error: `이 반품의 출고(${list})는 그 뒤 실사(${md})에 반영됐을 수 있어 함께 지우지 않습니다 — 다시 지우고 확인하면 반품 기록만 지웁니다.`,
          confirm: `이 반품으로 재고에서 뺀 출고(${list})는 그 뒤 실사(${md})에 이미 반영됐을 수 있습니다 — 출고를 지우면 재고가 실물보다 많아집니다.\n\n반품 기록만 지우고 출고는 둘까요? 다시 입력한 뒤 뜨는 [재고에서도 빼기]는 [건너뛰기]하세요.`,
        }, { status: 409 });
        kept = keyed.rows; keptAt = md;
      } else {
        if (mode !== "1") return NextResponse.json({
          ok: false, code: "return_has_outflow", orders: list, confirm_as: "1",
          error: `이 반품으로 재고에서 뺀 출고(${list})가 있습니다 — [입고 및 출고]에서 그 출고를 먼저 취소한 뒤 지우세요.`,
          confirm: `이 반품으로 재고에서 뺀 출고(${list})가 있습니다.\n\n반품 기록과 이 출고를 함께 지울까요? 재고가 원복됩니다 — 다시 입력했으면 [재고에서도 빼기]를 다시 누르세요.`,
        }, { status: 409 });
        // [재고에서도 빼기]가 남긴 그대로인가(출고·import·잠금 없음) — 다른 화면에서 바뀐 행이면 여기서 지우지 않는다(입출고 취소와 같은 규칙)
        if (keyed.rows.some((r) => r.type !== "출고" || (r.source != null && r.source !== "import") || lockKindOf(r as LedgerMark)))
          return NextResponse.json({ ok: false, error: `이 반품의 출고(${list}) 중 다른 기록과 묶인 행이 있습니다 — [입고 및 출고]에서 직접 취소한 뒤 지우세요.` }, { status: 409 });
        const { error: de } = await sb.from("inventory_txns").delete().in("id", keyed.rows.map((r) => String(r.id)));
        if (de) return NextResponse.json({ ok: false, error: `출고 취소에 실패해 반품도 지우지 않았습니다 — 다시 시도하세요. (${de.message})` }, { status: 500 });
        canceled = keyed.rows;
      }
    } else if (maybe.rows.length && mode !== "keep") {
      const list = ordersOf(maybe.rows);
      return NextResponse.json({
        ok: false, code: "return_maybe_outflow", orders: list, confirm_as: "keep",
        error: `같은 날 같은 품목의 제조사 반품 출고(${list})가 있습니다 — 이 반품으로 뺀 출고면 [입고 및 출고]에서 그 출고도 취소하세요.`,
        confirm: `같은 날 같은 품목의 제조사 반품 출고(${list})가 있습니다. 이 반품 것인지 알 수 없어 함께 지우지 않습니다.\n\n반품 기록만 지울까요? 이 반품으로 뺀 출고면 [입고 및 출고]에서 직접 취소하세요.`,
      }, { status: 409 });
    }

    const { error } = await sb.from("purchase_returns").delete().eq("id", id);
    if (error) {
      if (canceled.length) return NextResponse.json({ ok: false, error: `출고(${ordersOf(canceled)})는 취소됐지만 반품 기록을 지우지 못했습니다 — 다시 지우세요.` }, { status: 500 });
      throw error;
    }

    const warn: string[] = [];
    if (kept.length) warn.push(`출고(${ordersOf(kept)})는 실사(${keptAt})에 반영돼 있어 그대로 두었습니다 — 다시 입력한 뒤 뜨는 [재고에서도 빼기]는 [건너뛰기]하세요.`);
    if (maybe.rows.length) warn.push(`같은 날 같은 품목의 제조사 반품 출고(${ordersOf(maybe.rows)})는 그대로입니다 — 이 반품으로 뺀 출고면 [입고 및 출고]에서 취소하세요.`);
    if (keyed.missing131 && maybe.unknown) warn.push("이미 [재고에서도 빼기]를 눌렀다면 [입고 및 출고]에서 그 출고를 직접 취소하세요.");
    // 지우는 사이 다른 창의 [재고에서도 빼기]가 같은 키로 출고를 남겼을 수 있다 — 다시 보고 알린다(그대로 둔 출고는 빼고)
    if (!keyed.missing131) {
      const late = await keyedOutflows(sb, id);
      const keptIds = new Set(kept.map((r) => String(r.id)));
      const fresh = late.rows.filter((r) => !keptIds.has(String(r.id)));
      if (late.error) warn.push("지우는 사이 출고가 기록됐는지 확인하지 못했습니다 — [입고 및 출고]에서 확인하세요.");
      else if (fresh.length) warn.push(`지우는 사이 이 반품의 출고(${ordersOf(fresh)})가 기록됐습니다 — [입고 및 출고]에서 취소하세요.`);
    }
    return NextResponse.json({
      ok: true,
      ...(canceled.length ? { canceled: ordersOf(canceled) } : {}),
      ...(kept.length ? { kept: ordersOf(kept) } : {}),
      ...(warn.length ? { warning: warn.join(" ") } : {}),
    });
  } catch (err) {
    console.error("[inventory/returns DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
