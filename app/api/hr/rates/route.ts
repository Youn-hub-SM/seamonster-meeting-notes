import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { isDate } from "@/app/lib/hr";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f-]{36}$/i;
const COLS = "id,effective_from,pension_rate,pension_min,pension_max,health_rate,health_min_premium,health_max_premium,ltc_rate,employ_rate,employ_employer_rate,min_wage,child_credit_1,child_credit_2,child_credit_more,meal_limit,car_limit,childcare_limit,note,checked";

// [칸, 이름, 최대] — 요율(%)
const PCT: [string, string, number][] = [
  ["pension_rate", "국민연금 요율", 30], ["health_rate", "건강보험 요율", 30], ["ltc_rate", "장기요양 요율", 10],
  ["employ_rate", "고용보험 요율", 10], ["employ_employer_rate", "고용보험 사업주 요율", 10],
];
// 금액(원)
const WON: [string, string][] = [
  ["pension_min", "기준소득월액 하한"], ["pension_max", "기준소득월액 상한"], ["health_min_premium", "건강보험료 하한"], ["health_max_premium", "건강보험료 상한"],
  ["min_wage", "최저임금"], ["child_credit_1", "자녀 공제 1명"], ["child_credit_2", "자녀 공제 2명"], ["child_credit_more", "자녀 공제 3명부터"],
  ["meal_limit", "식대 한도"], ["car_limit", "자가운전 한도"], ["childcare_limit", "보육수당 한도"],
];

function parse(body: Row, partial: boolean): { row: Row; errors: Record<string, string> } {
  const row: Row = {};
  const errors: Record<string, string> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has("effective_from")) {
    const v = String(body.effective_from ?? "").trim();
    if (!isDate(v)) errors.effective_from = "적용 시작일을 입력하세요";
    else row.effective_from = v;
  }
  for (const [k, label, max] of PCT) {
    if (partial && !has(k)) continue;
    const n = Number(String(body[k] ?? "").trim() === "" ? NaN : body[k]);
    if (!Number.isFinite(n) || n < 0 || n > max) errors[k] = `${label}은 0~${max} 사이 숫자(%)`;
    else row[k] = n;
  }
  for (const [k, label] of WON) {
    if (partial && !has(k)) continue;
    const raw = String(body[k] ?? "").replace(/,/g, "").trim();
    const n = raw === "" ? NaN : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 2_000_000_000) errors[k] = `${label}은 0 이상 정수(원)`;
    else row[k] = n;
  }
  if (typeof row.pension_min === "number" && typeof row.pension_max === "number" && row.pension_max < row.pension_min) errors.pension_max = "상한이 하한보다 작습니다";
  if (typeof row.health_min_premium === "number" && typeof row.health_max_premium === "number" && row.health_max_premium < row.health_min_premium) errors.health_max_premium = "상한이 하한보다 작습니다";
  if (has("note")) row.note = String(body.note ?? "").trim().slice(0, 1000);
  if (has("checked")) row.checked = !!body.checked;
  return { row, errors };
}

const NUMERIC = ["pension_rate", "health_rate", "ltc_rate", "employ_rate", "employ_employer_rate"];
const toRate = (r: Row) => { const o: Row = { ...r }; for (const k of NUMERIC) o[k] = Number(r[k]); return o; };

// GET /api/hr/rates — 요율표(적용 시작일 내림차순)
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const { data, error } = await hrDb().from("rates").select(COLS).order("effective_from", { ascending: false });
    if (error) throw error;
    return hrJson({ ok: true, rates: ((data || []) as unknown as Row[]).map(toRate) });
  } catch (err) {
    return hrError(err, "요율을 불러오지 못했습니다.");
  }
}

// POST /api/hr/rates — 적용 시작일 한 줄 추가
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const { row, errors } = parse((await req.json()) as Row, false);
    if (Object.keys(errors).length > 0) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: errors }, 400);
    const { data, error } = await hrDb().from("rates").insert({ ...row, updated_by: who.name }).select(COLS).single();
    if (error) {
      if (/duplicate key/.test(error.message)) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { effective_from: "그 날짜의 요율이 이미 있습니다" } }, 409);
      throw error;
    }
    const saved = data as unknown as Row;
    await hrAudit({ actor: who.name, action: "rate_create", ip: clientIp(req), targetType: "rate", targetId: String(saved.id), targetName: String(saved.effective_from), detail: { row } });
    return hrJson({ ok: true, rate: toRate(saved) });
  } catch (err) {
    return hrError(err, "요율을 추가하지 못했습니다.");
  }
}

// PATCH /api/hr/rates — { id, …바꿀 칸 }. 이미 확정한 급여는 그때의 금액을 따로 보관하므로 바뀌지 않는다.
export async function PATCH(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as Row;
    const id = String(body.id ?? "");
    if (!UUID.test(id)) return hrJson({ ok: false, error: "없는 요율입니다." }, 404);
    const { row, errors } = parse(body, true);
    if (Object.keys(errors).length > 0) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: errors }, 400);
    if (Object.keys(row).length === 0) return hrJson({ ok: false, error: "바꿀 내용이 없습니다." }, 400);
    const { data, error } = await hrDb().from("rates").update({ ...row, updated_by: who.name, updated_at: new Date().toISOString() }).eq("id", id).select(COLS).maybeSingle();
    if (error) {
      if (/duplicate key/.test(error.message)) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { effective_from: "그 날짜의 요율이 이미 있습니다" } }, 409);
      throw error;
    }
    if (!data) return hrJson({ ok: false, error: "없는 요율입니다." }, 404);
    const saved = data as unknown as Row;
    await hrAudit({ actor: who.name, action: "rate_update", ip: clientIp(req), targetType: "rate", targetId: id, targetName: String(saved.effective_from), detail: { changed: row } });
    return hrJson({ ok: true, rate: toRate(saved) });
  } catch (err) {
    return hrError(err, "요율을 저장하지 못했습니다.");
  }
}

// DELETE /api/hr/rates?id= — 한 줄 삭제(마지막 한 줄은 지우지 못한다)
export async function DELETE(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!UUID.test(id)) return hrJson({ ok: false, error: "없는 요율입니다." }, 404);
  try {
    const all = await hrDb().from("rates").select(COLS);
    if (all.error) throw all.error;
    const rows = (all.data || []) as unknown as Row[];
    const hit = rows.find((r) => String(r.id) === id);
    if (!hit) return hrJson({ ok: false, error: "없는 요율입니다." }, 404);
    if (rows.length <= 1) return hrJson({ ok: false, error: "요율이 한 줄뿐이라 지울 수 없습니다." }, 400);
    const { error } = await hrDb().from("rates").delete().eq("id", id);
    if (error) throw error;
    await hrAudit({ actor: who.name, action: "rate_delete", ip: clientIp(req), targetType: "rate", targetId: id, targetName: String(hit.effective_from), detail: { row: hit } });
    return hrJson({ ok: true });
  } catch (err) {
    return hrError(err, "요율을 지우지 못했습니다.");
  }
}
