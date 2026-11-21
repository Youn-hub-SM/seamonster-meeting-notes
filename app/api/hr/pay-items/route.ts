import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { HR_PENDING_003, ITEM_COLS, UUID_RE, fetchPayItems, toPayItem } from "@/app/lib/hr-pay-db";
import { ITEM_TAX_KINDS } from "@/app/lib/hr-pay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = Record<string, unknown>;

// 직접 넣는 급여 항목(식대·상여·정산 등). 근무대장에서 나오는 지급과 법정 공제는 여기 없다(코드에 있다).
function parse(body: Row, partial: boolean): { row: Row; errors: Record<string, string> } {
  const row: Row = {}, errors: Record<string, string> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has("name")) {
    const v = String(body.name ?? "").trim().slice(0, 30);
    if (!v) errors.name = "항목 이름을 입력하세요"; else row.name = v;
  }
  if (!partial || has("kind")) row.kind = body.kind === "deduct" ? "deduct" : "pay";
  if (!partial || has("tax")) row.tax = (ITEM_TAX_KINDS as readonly string[]).includes(String(body.tax)) ? body.tax : "taxable";
  if (row.kind === "deduct") row.tax = "taxable"; // 공제 항목에는 과세 구분이 없다
  if (!partial || has("fixed")) row.fixed = !!body.fixed;
  if (has("active")) row.active = !!body.active;
  if (has("sort")) { const n = Math.round(Number(body.sort)); if (Number.isFinite(n) && Math.abs(n) < 100000) row.sort = n; }
  return { row, errors };
}
const dup = (m: string) => /duplicate key/.test(m);

// GET /api/hr/pay-items — 전체(쓰지 않는 것 포함)
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    return hrJson({ ok: true, items: await fetchPayItems() });
  } catch (err) {
    return hrError(err, "급여 항목을 불러오지 못했습니다.", HR_PENDING_003);
  }
}

// POST /api/hr/pay-items — 추가
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const { row, errors } = parse((await req.json()) as Row, false);
    if (Object.keys(errors).length > 0) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: errors }, 400);
    if (row.sort === undefined) {
      const all = await fetchPayItems();
      row.sort = all.reduce((m, i) => Math.max(m, i.sort), 0) + 10;
    }
    const { data, error } = await hrDb().from("pay_items").insert({ ...row, updated_by: who.name }).select(ITEM_COLS).single();
    if (error) {
      if (dup(error.message)) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { name: "같은 이름의 항목이 이미 있습니다" } }, 409);
      throw error;
    }
    const item = toPayItem(data as unknown as Row);
    await hrAudit({ actor: who.name, action: "pay_item_create", ip: clientIp(req), targetType: "pay_item", targetId: item.id, targetName: item.name, detail: { row } });
    return hrJson({ ok: true, item });
  } catch (err) {
    return hrError(err, "급여 항목을 추가하지 못했습니다.", HR_PENDING_003);
  }
}

// PATCH /api/hr/pay-items — { id, …바꿀 칸 }. 지우지 않고 '사용'을 끈다(지난 급여대장에 이름이 남아 있다).
export async function PATCH(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as Row;
    const id = String(body.id ?? "");
    if (!UUID_RE.test(id)) return hrJson({ ok: false, error: "없는 항목입니다." }, 404);
    const { row, errors } = parse(body, true);
    if (Object.keys(errors).length > 0) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: errors }, 400);
    if (Object.keys(row).length === 0) return hrJson({ ok: false, error: "바꿀 내용이 없습니다." }, 400);
    const { data, error } = await hrDb().from("pay_items").update({ ...row, updated_by: who.name, updated_at: new Date().toISOString() }).eq("id", id).select(ITEM_COLS).maybeSingle();
    if (error) {
      if (dup(error.message)) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { name: "같은 이름의 항목이 이미 있습니다" } }, 409);
      throw error;
    }
    if (!data) return hrJson({ ok: false, error: "없는 항목입니다." }, 404);
    const item = toPayItem(data as unknown as Row);
    await hrAudit({ actor: who.name, action: "pay_item_update", ip: clientIp(req), targetType: "pay_item", targetId: id, targetName: item.name, detail: { changed: row } });
    return hrJson({ ok: true, item });
  } catch (err) {
    return hrError(err, "급여 항목을 저장하지 못했습니다.", HR_PENDING_003);
  }
}
