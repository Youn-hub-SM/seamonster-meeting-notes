import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { HR_PENDING_005 } from "@/app/lib/hr-docs-db";
import { clearAttempts, failState, newToken, openToken, sealToken, tokenHash } from "@/app/lib/hr-me";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f-]{36}$/i;
const COLS = "id,employee_id,token_enc,version,active,created_at,updated_at,last_opened_at";

// 직원 확인 링크 관리(급여 창 안) — 직원 한 명에 링크 하나.
//  링크 주소는 화면이 지금 주소에 /me/<토큰> 을 붙여 만든다(토큰은 암호문을 풀어 여기서만 준다).
//  blocked = 본인 확인을 계속 틀려 잠긴 링크 — [링크 다시 만들기]를 해야 풀린다.
const view = async (r: Row | null) => (r ? {
  token: openToken(String(r.token_enc)), active: r.active !== false, version: Number(r.version) || 1,
  created_at: String(r.created_at || ""), updated_at: String(r.updated_at || ""), last_opened_at: (r.last_opened_at as string) || null,
  blocked: r.active !== false && (await failState(String(r.id))).blocked,
} : null);

// GET /api/hr/links?employee=<id>
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const id = req.nextUrl.searchParams.get("employee") || "";
  if (!UUID.test(id)) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);
  try {
    const { data, error } = await hrDb().from("employee_links").select(COLS).eq("employee_id", id).maybeSingle();
    if (error) throw error;
    return hrJson({ ok: true, link: await view(data as unknown as Row | null) });
  } catch (err) {
    return hrError(err, "직원 확인 링크를 불러오지 못했습니다.", HR_PENDING_005);
  }
}

// POST /api/hr/links — { employee_id, action }
//   create      링크 만들기(이미 있으면 그대로 돌려준다)
//   regenerate  링크 다시 만들기 — 옛 링크와 옛 기기의 확인 상태가 함께 무효가 된다
//   revoke      링크 끊기
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { employee_id?: string; action?: string };
    const employeeId = String(body.employee_id ?? "");
    const action = String(body.action ?? "");
    if (!UUID.test(employeeId)) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);
    if (!["create", "regenerate", "revoke"].includes(action)) return hrJson({ ok: false, error: "알 수 없는 요청입니다." }, 400);

    const emp = await hrDb().from("employees").select("id,name,rrn_hash").eq("id", employeeId).maybeSingle();
    if (emp.error) throw emp.error;
    const e = emp.data as { id: string; name: string; rrn_hash: string | null } | null;
    if (!e) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);
    if (action !== "revoke" && !e.rrn_hash) {
      return hrJson({ ok: false, error: "주민등록번호가 없는 직원은 링크에서 본인 확인을 할 수 없습니다. 인사대장에 번호를 먼저 넣으세요." }, 400);
    }

    const cur = await hrDb().from("employee_links").select(COLS).eq("employee_id", employeeId).maybeSingle();
    if (cur.error) throw cur.error;
    const had = cur.data as unknown as Row | null;
    const now = new Date().toISOString();
    let saved: Row | null = had;

    if (action === "revoke") {
      if (!had) return hrJson({ ok: false, error: "만든 링크가 없습니다." }, 404);
      const r = await hrDb().from("employee_links").update({ active: false, updated_by: who.name, updated_at: now }).eq("employee_id", employeeId).select(COLS).single();
      if (r.error) throw r.error;
      saved = r.data as unknown as Row;
    } else if (!had) {
      const token = newToken();
      const r = await hrDb().from("employee_links").insert({ employee_id: employeeId, token_hash: tokenHash(token), token_enc: sealToken(token), created_by: who.name, updated_by: who.name }).select(COLS).single();
      if (r.error) throw r.error;
      saved = r.data as unknown as Row;
    } else if (action === "regenerate" || had.active === false) {
      // 끊은 링크를 다시 만들 때도 새 토큰으로 — 끊기 전의 주소가 되살아나지 않게
      const token = newToken();
      const r = await hrDb().from("employee_links")
        .update({ token_hash: tokenHash(token), token_enc: sealToken(token), version: (Number(had.version) || 1) + 1, active: true, updated_by: who.name, updated_at: now })
        .eq("employee_id", employeeId).select(COLS).single();
      if (r.error) throw r.error;
      saved = r.data as unknown as Row;
      await clearAttempts(String(had.id)); // 새 주소는 틀린 횟수 0 에서 시작한다(잠긴 링크가 풀린다)
    }
    await hrAudit({ actor: who.name, action: `link_${action}`, ip: clientIp(req), targetType: "employee", targetId: e.id, targetName: e.name });
    return hrJson({ ok: true, link: await view(saved) });
  } catch (err) {
    return hrError(err, "직원 확인 링크를 저장하지 못했습니다.", HR_PENDING_005);
  }
}
