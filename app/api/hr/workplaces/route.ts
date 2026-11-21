import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { HR_PENDING_006, missingAffiliation, type DbResult } from "@/app/lib/hr-employees";
import { AFFILIATION_MAX, AFFILIATION_NAME_MAX, parseAffiliations } from "@/app/lib/hr";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f-]{36}$/i;
const COLS_BASE = "id,name,biz_no,ceo,address,phone,five_plus,week_start,weekly_pay_month,auto_weekly,payday,accident_rate,employ_extra_rate,fiscal_start,leave_basis,leave_round,sort,active";
const COLS = `${COLS_BASE},affiliations`;

// 소속 칸(hr/006)이 아직 없는 DB 에서도 사업장 화면이 멈추지 않게 한다.
//  읽기: 소속 칸 없이 다시 읽는다. 쓰기: 소속 목록이 비어 있으면 그 칸을 빼고 다시 쓰고, 이름이 들어 있으면 'DB 준비 전'으로 거절한다.
async function read(run: (cols: string) => PromiseLike<DbResult>): Promise<DbResult> {
  const first = await run(COLS);
  return first.error && missingAffiliation(first.error) ? await run(COLS_BASE) : first;
}
async function write(row: Row, run: (row: Row, cols: string) => PromiseLike<DbResult>): Promise<DbResult> {
  const first = await run(row, COLS);
  if (!first.error || !missingAffiliation(first.error)) return first;
  if (Array.isArray(row.affiliations) && row.affiliations.length > 0) return { data: null, error: { code: "HR006", message: HR_PENDING_006 } };
  const rest = { ...row };
  delete rest.affiliations;
  return await run(rest, COLS_BASE);
}

function parse(body: Row, partial: boolean): { row: Row; errors: Record<string, string> } {
  const row: Row = {};
  const errors: Record<string, string> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has("name")) {
    const v = String(body.name ?? "").trim();
    if (!v) errors.name = "사업장 이름을 입력하세요";
    else if (v.length > 60) errors.name = "60자 이하";
    else row.name = v;
  }
  for (const [k, max] of [["biz_no", 20], ["ceo", 40], ["address", 300], ["phone", 40]] as const) {
    if (!has(k)) continue;
    const v = String(body[k] ?? "").trim();
    if (v.length > max) errors[k] = `${max}자 이하`;
    else row[k] = v;
  }
  for (const k of ["five_plus", "auto_weekly", "active"]) if (has(k)) row[k] = !!body[k];
  if (has("week_start")) {
    const n = Number(body.week_start);
    row.week_start = Number.isInteger(n) && n >= 1 && n <= 7 ? n : 1;
  }
  if (has("weekly_pay_month")) row.weekly_pay_month = body.weekly_pay_month === "start" ? "start" : "end";
  if (has("payday")) {
    const n = Number(body.payday);
    if (!Number.isInteger(n) || n < 1 || n > 31) errors.payday = "1~31 사이 숫자";
    else row.payday = n;
  }
  for (const [k, label] of [["accident_rate", "산재보험 요율"], ["employ_extra_rate", "고용안정·직업능력 요율"]] as const) {
    if (!has(k)) continue;
    const n = Number(body[k] === "" || body[k] == null ? 0 : body[k]);
    if (!Number.isFinite(n) || n < 0 || n > 50) errors[k] = `${label}은 0~50 사이 숫자(%)`;
    else row[k] = Math.round(n * 10000) / 10000;
  }
  if (has("fiscal_start")) {
    const v = String(body.fiscal_start ?? "").trim();
    const ok = /^\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`2024-${v}T00:00:00Z`)) && new Date(`2024-${v}T00:00:00Z`).toISOString().slice(5, 10) === v;
    if (!ok) errors.fiscal_start = "월-일 형식(01-01)";
    else row.fiscal_start = v;
  }
  if (has("leave_basis")) row.leave_basis = body.leave_basis === "hire" ? "hire" : "fiscal";
  if (has("leave_round")) {
    const v = String(body.leave_round);
    row.leave_round = ["ceil_half", "ceil_one", "round_half", "none"].includes(v) ? v : "ceil_half";
  }
  // 소속 목록: 쉼표·줄바꿈으로 나눠 적은 글자 또는 이름 배열
  if (has("affiliations")) {
    const list = parseAffiliations(body.affiliations);
    if (list.length > AFFILIATION_MAX) errors.affiliations = `소속은 ${AFFILIATION_MAX}개까지`;
    else if (list.some((n) => n.length > AFFILIATION_NAME_MAX)) errors.affiliations = `소속 이름은 ${AFFILIATION_NAME_MAX}자 이하`;
    else row.affiliations = list;
  }
  return { row, errors };
}

const toWorkplace = (r: Row) => ({
  ...r, accident_rate: Number(r.accident_rate), employ_extra_rate: Number(r.employ_extra_rate),
  affiliations: Array.isArray(r.affiliations) ? (r.affiliations as unknown[]).map(String) : [],
});

// GET /api/hr/workplaces — 사업장 목록
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const { data, error } = await read((cols) => hrDb().from("workplaces").select(cols).order("sort").order("created_at"));
    if (error) throw error;
    return hrJson({ ok: true, workplaces: ((data || []) as unknown as Row[]).map(toWorkplace) });
  } catch (err) {
    return hrError(err, "사업장을 불러오지 못했습니다.");
  }
}

// POST /api/hr/workplaces — 사업장 등록
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const { row, errors } = parse((await req.json()) as Row, false);
    if (Object.keys(errors).length > 0) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: errors }, 400);
    const { data, error } = await write(row, (r, cols) => hrDb().from("workplaces").insert(r).select(cols).single());
    if (error) {
      if (error.code === "HR006") return hrJson({ ok: false, pending: true, error: HR_PENDING_006 }, 503);
      if (/workplaces_name_key|duplicate key/.test(String(error.message))) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { name: "이미 있는 사업장 이름입니다" } }, 409);
      throw error;
    }
    const saved = data as unknown as Row;
    await hrAudit({ actor: who.name, action: "workplace_create", ip: clientIp(req), targetType: "workplace", targetId: String(saved.id), targetName: String(saved.name) });
    return hrJson({ ok: true, workplace: toWorkplace(saved) });
  } catch (err) {
    return hrError(err, "사업장을 등록하지 못했습니다.");
  }
}

// PATCH /api/hr/workplaces — { id, …바꿀 칸 }
export async function PATCH(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as Row;
    const id = String(body.id ?? "");
    if (!UUID.test(id)) return hrJson({ ok: false, error: "없는 사업장입니다." }, 404);
    const { row, errors } = parse(body, true);
    if (Object.keys(errors).length > 0) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: errors }, 400);
    if (Object.keys(row).length === 0) return hrJson({ ok: false, error: "바꿀 내용이 없습니다." }, 400);
    const { data, error } = await write(row, (r, cols) => hrDb().from("workplaces").update({ ...r, updated_at: new Date().toISOString() }).eq("id", id).select(cols).maybeSingle());
    if (error) {
      if (error.code === "HR006") return hrJson({ ok: false, pending: true, error: HR_PENDING_006 }, 503);
      if (/workplaces_name_key|duplicate key/.test(String(error.message))) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { name: "이미 있는 사업장 이름입니다" } }, 409);
      throw error;
    }
    if (!data) return hrJson({ ok: false, error: "없는 사업장입니다." }, 404);
    const saved = data as unknown as Row;
    await hrAudit({ actor: who.name, action: "workplace_update", ip: clientIp(req), targetType: "workplace", targetId: id, targetName: String(saved.name), detail: { changed: row } });
    return hrJson({ ok: true, workplace: toWorkplace(saved) });
  } catch (err) {
    return hrError(err, "사업장을 저장하지 못했습니다.");
  }
}
