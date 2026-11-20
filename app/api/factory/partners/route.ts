import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending012, PENDING_012 } from "@/app/lib/factory-db";
import { normPartnerName, parsePartnerInput, type FactoryPartner } from "@/app/lib/factory-partners";

export const dynamic = "force-dynamic";

// 파도소리 거래처 목록(factory.partners) — 모든 파도소리 계정이 보고 등록·수정한다. 삭제와 '기록에서 모으기'는 관리자만.
//  기록(stock_txns.partner)은 이름으로 남는다 — 이 표는 고르는 목록이자 사업자 정보의 원본.
const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });
const pending = () => NextResponse.json({ ok: false, error: PENDING_012, pending_migration: true }, { status: 503 });

async function allPartners(): Promise<FactoryPartner[]> {
  const out: FactoryPartner[] = [];
  for (let at = 0; ; at += 1000) {
    const { data, error } = await factoryDb().from("partners").select("*").order("name").order("id").range(at, at + 999);
    if (error) throw error;
    out.push(...((data || []) as FactoryPartner[]));
    if (!data || data.length < 1000) return out;
  }
}

export async function GET(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    return NextResponse.json({ ok: true, partners: await allPartners(), admin: u.admin });
  } catch (err) {
    if (isPending012(err)) return pending();
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "거래처 조회 실패") }, { status: 500 });
  }
}

// POST { name, kind, ... } — 등록
// POST { collect: true }   — 기록에 적힌 거래처 이름 중 목록에 없는 것을 모아 등록(관리자). 매입 기록에만 나온 이름은 매입처, 나머지는 매출처.
export async function POST(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const db = factoryDb();

    if (b.collect) {
      if (!u.admin) return bad("권한이 없습니다.", 403);
      const have = new Set((await allPartners()).map((p) => p.name.toLowerCase()));
      const seen = new Map<string, { name: string; buy: boolean; other: boolean }>();
      let cols = "id, partner, kind";
      for (let at = 0; ; at += 1000) {
        const read = () => db.from("stock_txns").select(cols).not("partner", "is", null).order("id").range(at, at + 999);
        let { data, error } = await read();
        if (error && /kind/.test(error.message)) { cols = "id, partner"; ({ data, error } = await read()); }
        if (error) throw error;
        for (const r of (data || []) as unknown as { partner: string | null; kind?: string | null }[]) {
          const name = normPartnerName(r.partner);
          if (!name || name.length > 60) continue;
          const k = name.toLowerCase();
          const e = seen.get(k) || { name, buy: false, other: false };
          if (r.kind === "매입") e.buy = true; else e.other = true;
          seen.set(k, e);
        }
        if (!data || data.length < 1000) break;
      }
      const rows = [...seen.entries()].filter(([k]) => !have.has(k))
        .map(([, e]) => ({ name: e.name, kind: e.buy && e.other ? "둘 다" : e.buy ? "매입처" : "매출처", created_by: u.name, updated_by: u.name }));
      if (rows.length) {
        const { error } = await db.from("partners").insert(rows);
        if (error) throw error;
      }
      return NextResponse.json({ ok: true, added: rows.length });
    }

    const { patch, error: pe } = parsePartnerInput(b);
    if (pe) return bad(pe);
    const { data, error } = await db.from("partners").insert({ ...patch, created_by: u.name, updated_by: u.name }).select("*").single();
    if (error) {
      if ((error as { code?: string }).code === "23505") return bad("이미 있는 업체명입니다.");
      throw error;
    }
    return NextResponse.json({ ok: true, partner: data });
  } catch (err) {
    if (isPending012(err)) return pending();
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "거래처 저장 실패") }, { status: 500 });
  }
}
