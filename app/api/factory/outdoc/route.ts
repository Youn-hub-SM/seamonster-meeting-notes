import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending012, PENDING_012, readFactoryCompany } from "@/app/lib/factory-db";
import { DEFAULT_STORAGE } from "@/app/lib/factory";
import type { OutDoc, OutDocLine } from "@/app/lib/factory-partners";

export const dynamic = "force-dynamic";

// GET ?batch=<입력 번호> — 출고 한 건의 출고증 내용. 번호가 아직 없으면 지금 매긴다(factory.issue_out_doc — 다시 불러도 같은 번호).
//  대상은 그 묶음의 취소 안 된 '매출' 출고(구분 없는 옛 출고 포함). 현장 투입·이동은 출고증이 없다.
//  받는 곳이 보관처이므로 보관처마다 한 묶음으로 나눈다. 모든 계정.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });
const n = (v: unknown) => (v == null ? null : Number(v));
const lotKey = (t: { product_id: string; mfg_date: string | null; box_kg: number | string | null; storage?: string | null }) =>
  `${t.product_id}|${t.mfg_date ?? ""}|${t.box_kg == null ? "" : Number(t.box_kg)}|${t.storage || DEFAULT_STORAGE}`;

export async function GET(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    const batch = req.nextUrl.searchParams.get("batch") || "";
    if (!UUID_RE.test(batch)) return bad("출고 기록을 찾을 수 없습니다.", 404);
    const db = factoryDb();

    const issued = await db.rpc("issue_out_doc", { p_batch: batch, p_actor: u.name });
    if (issued.error) {
      if ((issued.error as { code?: string }).code === "P0001") return bad(issued.error.message);
      throw issued.error;
    }
    const doc = issued.data as { doc_no: string; out_date: string; partner: string | null; created_at: string };

    type Tx = { product_id: string; mfg_date: string | null; kg: number | string; box_kg: number | string | null; storage: string | null; partner: string | null; kind: string | null; created_at: string };
    const tx = await db.from("stock_txns").select("product_id, mfg_date, kg, box_kg, storage, partner, kind, created_at")
      .eq("batch_id", batch).eq("type", "출고").is("cancelled_at", null).order("created_at").order("id").limit(1000);
    if (tx.error) throw tx.error;
    const outs = ((tx.data || []) as Tx[]).filter((t) => !t.kind || t.kind === "매출");
    if (!outs.length) return bad("출고증을 낼 출고 기록이 없습니다(취소됐을 수 있습니다).");

    const ids = [...new Set(outs.map((t) => t.product_id))];
    const [pr, ins, company] = await Promise.all([
      db.from("products").select("id, name, spec, origin").in("id", ids),
      // 이 품목들의 입고 기록 — 로트의 입고일·테잎색·본선명을 찾는다(최신순: 가장 최근에 적은 값을 쓴다)
      db.from("stock_txns").select("product_id, mfg_date, box_kg, storage, txn_date, tape_color, vessel")
        .in("product_id", ids).eq("type", "입고").is("cancelled_at", null).order("created_at", { ascending: false }).limit(5000),
      readFactoryCompany(),
    ]);
    if (pr.error) throw pr.error;
    if (ins.error) throw ins.error;
    const prod = new Map(((pr.data || []) as { id: string; name: string; spec: string | null; origin: string | null }[]).map((p) => [p.id, p]));
    const firstIn = new Map<string, string>(), tape = new Map<string, string>(), vessel = new Map<string, string>();
    for (const t of (ins.data || []) as { product_id: string; mfg_date: string | null; box_kg: number | string | null; storage: string | null; txn_date: string; tape_color: string | null; vessel: string | null }[]) {
      const k = lotKey(t);
      if (!firstIn.has(k) || t.txn_date < firstIn.get(k)!) firstIn.set(k, t.txn_date);
      if (t.tape_color && !tape.has(k)) tape.set(k, t.tape_color);
      if (t.vessel && !vessel.has(k)) vessel.set(k, t.vessel);
    }

    const sheets = new Map<string, OutDocLine[]>();
    for (const t of outs) {
      const p = prod.get(t.product_id);
      const storage = t.storage || DEFAULT_STORAGE;
      const kg = Math.abs(Number(t.kg)), bk = n(t.box_kg), k = lotKey(t);
      const boxes = bk && bk > 0 ? kg / bk : null;
      const whole = boxes != null && Math.abs(boxes - Math.round(boxes)) < 1e-6;
      const line: OutDocLine = {
        name: p?.name || "", spec: p?.spec || "", vessel: vessel.get(k) || "",
        memo: [tape.get(k), p?.origin].filter(Boolean).join(" "),
        unit: whole ? `${bk}KG` : "KG", qty: whole ? Math.round(boxes!) : Math.round(kg * 100) / 100,
        in_date: firstIn.get(k) || t.mfg_date || "",
      };
      if (!sheets.has(storage)) sheets.set(storage, []);
      sheets.get(storage)!.push(line);
    }
    const out: OutDoc = {
      doc_no: doc.doc_no, out_date: doc.out_date,
      partner: doc.partner || outs.find((t) => t.partner)?.partner || "",
      issued_at: doc.created_at,
      sheets: [...sheets.entries()].map(([storage, lines]) => ({ storage, lines })),
      company,
    };
    return NextResponse.json({ ok: true, doc: out });
  } catch (err) {
    if (isPending012(err)) return NextResponse.json({ ok: false, error: PENDING_012, pending_migration: true }, { status: 503 });
    console.error("[factory/outdoc GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "출고증 조회 실패") }, { status: 500 });
  }
}
