import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending010, PENDING_010 } from "@/app/lib/factory-db";
import { FLOW_KINDS, type FlowKind, type FlowTuple } from "@/app/lib/factory-flow";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 파도소리 [예상] — 출고 데이터 올리기. 관리자만.
//  브라우저가 엑셀 두 개를 읽어 합친 결과(일자 × 흐름 × 품명)를 묶음으로 나눠 보낸다(원본 행은 오지 않는다).
//   POST { batch, rows: FlowTuple[] }            — 한 묶음 넣기(아직 화면에 안 보임)
//   POST { batch, commit: true, from, to }       — 마무리: 같은 기간의 옛 기록을 지우고 이번 것을 공개(factory.commit_flows)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 6000;
const bad = (error: string) => NextResponse.json({ ok: false, error }, { status: 400 });

export async function POST(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    if (!u.admin) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 403 });
    const b = (await req.json().catch(() => null)) as { batch?: string; rows?: unknown; commit?: boolean; from?: string; to?: string } | null;
    if (!b || !UUID_RE.test(String(b.batch || ""))) return bad("요청이 올바르지 않습니다.");

    if (b.commit) {
      if (!DATE_RE.test(String(b.from || "")) || !DATE_RE.test(String(b.to || "")) || b.from! > b.to!) return bad("기간이 올바르지 않습니다.");
      const { data, error } = await factoryDb().rpc("commit_flows", { p_batch: b.batch, p_from: b.from, p_to: b.to });
      if (error) throw error;
      return NextResponse.json({ ok: true, committed: data });
    }

    if (!Array.isArray(b.rows) || !b.rows.length) return bad("올릴 기록이 없습니다.");
    if (b.rows.length > MAX_ROWS) return bad("한 번에 보낼 수 있는 양을 넘었습니다.");
    const recs = [];
    for (const r of b.rows as FlowTuple[]) {
      if (!Array.isArray(r) || !DATE_RE.test(String(r[0])) || !FLOW_KINDS.includes(r[1] as FlowKind)
        || typeof r[2] !== "string" || !r[2] || typeof r[4] !== "number" || !Number.isFinite(r[4])) return bad("기록 형식이 올바르지 않습니다.");
      recs.push({
        flow_date: r[0], kind: r[1], item: r[2].slice(0, 200), partner: String(r[3] ?? "").slice(0, 200),
        kg: r[4], processed: !!r[5], big: !!r[6], batch_id: b.batch, created_by: u.name,
      });
    }
    const { error } = await factoryDb().from("flows").insert(recs);
    if (error) throw error;
    return NextResponse.json({ ok: true, inserted: recs.length });
  } catch (err) {
    if (isPending010(err)) return NextResponse.json({ ok: false, error: PENDING_010, pending_migration: true }, { status: 503 });
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "올리기 실패") }, { status: 500 });
  }
}
