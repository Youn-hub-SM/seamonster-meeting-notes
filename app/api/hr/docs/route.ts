import { NextRequest } from "next/server";
import { clientIp, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { decryptRrn } from "@/app/lib/hr-crypto";
import { formatRrn, isDate } from "@/app/lib/hr";
import { isMonth } from "@/app/lib/hr-work";
import { DOC_KINDS, DOC_LABEL, issueNo, type DocKind } from "@/app/lib/hr-docs";
import { fetchStamp, fetchWithholding } from "@/app/lib/hr-docs-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f-]{36}$/i;

// 증명서(재직·경력·원천징수) — 내용은 인사대장·사업장 화면이 이미 받은 것을 쓰고, 여기서는 직인과 달별 원천징수 내역만 준다.

// GET /api/hr/docs?employee=<id>&workplace=<id>&from=YYYY-MM&to=YYYY-MM
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const sp = req.nextUrl.searchParams;
  const employee = sp.get("employee") || "", workplace = sp.get("workplace") || "";
  const from = sp.get("from") || "", to = sp.get("to") || "";
  if (!UUID.test(employee) || !UUID.test(workplace)) return hrJson({ ok: false, error: "직원을 고르세요." }, 400);
  if (!isMonth(from) || !isMonth(to) || to < from) return hrJson({ ok: false, error: "기간을 확인하세요." }, 400);
  try {
    const [stamp, withholding] = await Promise.all([fetchStamp(workplace), fetchWithholding(employee, from, to)]);
    return hrJson({ ok: true, stamp: stamp.image, stamp_pending: stamp.pending, withholding });
  } catch (err) {
    return hrError(err, "증명서 자료를 불러오지 못했습니다.");
  }
}

// POST /api/hr/docs — 발급. { employee_id, kind, purpose, submit_to, issue_date, full_rrn?, from?, to? }
//  발급한 사실을 이력에 남기고 그 줄의 번호로 발급 번호를 만든다. 이력을 남기지 못하면 발급하지 않는다.
//  full_rrn 이면 주민등록번호 전체를 돌려준다(이력에 '전체'로 남는다 — 번호 자체는 남기지 않는다).
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const employeeId = String(body.employee_id ?? "");
    const kind = String(body.kind ?? "") as DocKind;
    const issueDate = String(body.issue_date ?? "");
    if (!UUID.test(employeeId)) return hrJson({ ok: false, error: "직원을 고르세요." }, 400);
    if (!(DOC_KINDS as readonly string[]).includes(kind)) return hrJson({ ok: false, error: "서류를 고르세요." }, 400);
    if (!isDate(issueDate)) return hrJson({ ok: false, error: "발급일을 입력하세요." }, 400);
    const fullRrn = body.full_rrn === true;

    const { data, error } = await hrDb().from("employees").select("id,name,rrn_enc").eq("id", employeeId).maybeSingle();
    if (error) throw error;
    const e = data as { id: string; name: string; rrn_enc: string | null } | null;
    if (!e) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);

    const ins = await hrDb().from("audit_log").insert({
      actor: who.name, action: "doc_issue", ip: clientIp(req), target_type: "employee", target_id: e.id, target_name: e.name,
      detail: {
        kind, label: DOC_LABEL[kind], issue_date: issueDate, rrn: fullRrn ? "full" : "masked",
        purpose: String(body.purpose ?? "").trim().slice(0, 100), submit_to: String(body.submit_to ?? "").trim().slice(0, 100),
        ...(kind === "withholding" ? { from: String(body.from ?? ""), to: String(body.to ?? "") } : {}),
      },
    }).select("id").single();
    if (ins.error) throw ins.error;
    const no = issueNo(issueDate, Number((ins.data as { id: number }).id));
    return hrJson({ ok: true, no, rrn: fullRrn && e.rrn_enc ? formatRrn(decryptRrn(e.rrn_enc)) : null });
  } catch (err) {
    return hrError(err, "증명서를 발급하지 못했습니다.");
  }
}
