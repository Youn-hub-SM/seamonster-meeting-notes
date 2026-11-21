import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { HR_PENDING_005, fetchStamp } from "@/app/lib/hr-docs-db";
import { isStampDataUrl } from "@/app/lib/hr-docs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f-]{36}$/i;

// 사업장 직인 — 증명서를 인쇄할 때 대표자 이름 옆에 찍히는 그림(PNG·JPEG, 약 500KB 까지).

// GET /api/hr/stamp?workplace=<id>
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const id = req.nextUrl.searchParams.get("workplace") || "";
  if (!UUID.test(id)) return hrJson({ ok: false, error: "없는 사업장입니다." }, 404);
  try {
    const s = await fetchStamp(id);
    return hrJson({ ok: true, image: s.image, pending: s.pending });
  } catch (err) {
    return hrError(err, "직인을 불러오지 못했습니다.", HR_PENDING_005);
  }
}

// PUT /api/hr/stamp — { workplace_id, image(data URL) } 올리기(있으면 바꾼다)
export async function PUT(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { workplace_id?: string; image?: unknown };
    const id = String(body.workplace_id ?? "");
    if (!UUID.test(id)) return hrJson({ ok: false, error: "없는 사업장입니다." }, 404);
    if (!isStampDataUrl(body.image)) return hrJson({ ok: false, error: "PNG·JPG 그림 파일(500KB 이하)을 올리세요." }, 400);
    const wp = await hrDb().from("workplaces").select("id,name").eq("id", id).maybeSingle();
    if (wp.error) throw wp.error;
    if (!wp.data) return hrJson({ ok: false, error: "없는 사업장입니다." }, 404);
    const { error } = await hrDb().from("workplace_stamps").upsert({ workplace_id: id, image: body.image, updated_by: who.name, updated_at: new Date().toISOString() }, { onConflict: "workplace_id" });
    if (error) throw error;
    await hrAudit({ actor: who.name, action: "stamp_save", ip: clientIp(req), targetType: "workplace", targetId: id, targetName: String((wp.data as { name?: string }).name || ""), detail: { chars: body.image.length } });
    return hrJson({ ok: true, image: body.image });
  } catch (err) {
    return hrError(err, "직인을 올리지 못했습니다.", HR_PENDING_005);
  }
}

// DELETE /api/hr/stamp?workplace=<id>
export async function DELETE(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const id = req.nextUrl.searchParams.get("workplace") || "";
  if (!UUID.test(id)) return hrJson({ ok: false, error: "없는 사업장입니다." }, 404);
  try {
    const { error } = await hrDb().from("workplace_stamps").delete().eq("workplace_id", id);
    if (error) throw error;
    await hrAudit({ actor: who.name, action: "stamp_delete", ip: clientIp(req), targetType: "workplace", targetId: id });
    return hrJson({ ok: true });
  } catch (err) {
    return hrError(err, "직인을 지우지 못했습니다.", HR_PENDING_005);
  }
}
