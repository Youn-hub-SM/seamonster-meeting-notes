import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeCrmMessage } from "@/app/lib/crm";
import { seedMessages, csvToMessages } from "@/app/lib/crm-seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { mode: "seed" } | { mode: "csv", csv: string } — 1회성 데이터 이관.
//  이미 데이터가 있으면 거부(중복 이관 방지) — 부분 이관/재시도로 섞이는 사고를 막는 단순한 규칙.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { mode?: string; csv?: string };
    const mode = body.mode === "csv" ? "csv" : "seed";

    const { count, error: cntErr } = await supabaseAdmin().from("crm_messages").select("id", { count: "exact", head: true });
    if (cntErr) throw cntErr; // 테이블 없음(063 미적용) 등 — 에러 메시지 그대로 노출
    if ((count || 0) > 0) {
      return NextResponse.json({ ok: false, error: `이미 메시지 ${count}개가 있습니다. 가져오기는 빈 상태에서만 됩니다(중복 방지).` }, { status: 409 });
    }

    const inputs = mode === "csv" ? csvToMessages(body.csv || "") : seedMessages();
    if (inputs.length === 0) {
      return NextResponse.json({ ok: false, error: mode === "csv" ? "CSV에서 읽을 행이 없습니다. 헤더(스테이지·메시지명 등) 포함 전체를 붙여넣었는지 확인하세요." : "시드 데이터가 비어 있습니다." }, { status: 400 });
    }
    // 시드·CSV엔 선택 컬럼 값이 없으므로 074(날짜)·077(고객·유형) 키는 아예 뺀다 — 미적용 DB에서도 동작.
    const rows = inputs.map((i) => {
      const { id: _omit, start_date: _s, end_date: _e, customer: _c, msg_type: _t, ...row } = normalizeCrmMessage(i);
      void _omit; void _s; void _e; void _c; void _t;
      return row;
    });
    const { error } = await supabaseAdmin().from("crm_messages").insert(rows);
    if (error) throw error;
    return NextResponse.json({ ok: true, inserted: rows.length, mode });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "가져오기 실패") }, { status: 500 });
  }
}
