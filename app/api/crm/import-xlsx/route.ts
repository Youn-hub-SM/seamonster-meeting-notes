import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getCrmOptions, saveCrmOptions } from "@/app/lib/crm-options";
import { getCrmMediaExtra } from "@/app/lib/utm";
import { TIERS, toRow, missing } from "@/app/lib/crm-db";
import { planCrmImport, readCrmWorkbook, type ImportRowReport } from "@/app/lib/crm-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST multipart { file, replace: "0"|"1", apply: "0"|"1" } — CRM 메시지 엑셀 가져오기(2026-11-06).
//  apply=0: 미리보기(줄별 처리·오류·경고·자동 보정·새 단계/선택지). apply=1: 등록.
//  replace=1: 기존 메시지를 전부 지우고 파일 내용으로 새로(대표 결정 대기 — 화면 체크박스). 아니면 같은 메시지명은 덮어쓰고 나머지는 둔다.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "엑셀 파일을 올리세요" }, { status: 400 });
    if (file.size > 8 * 1024 * 1024) return NextResponse.json({ ok: false, error: "8MB 이하 파일만" }, { status: 400 });
    const replace = form.get("replace") === "1";
    const apply = form.get("apply") === "1";

    const { rows } = await readCrmWorkbook(Buffer.from(await file.arrayBuffer()));
    if (!rows.length) return NextResponse.json({ ok: false, error: "'메시지' 시트에 읽을 줄이 없습니다" }, { status: 400 });

    const sb = supabaseAdmin();
    const { data: existingRows, error: exErr } = await sb.from("crm_messages").select("id, title, stage, stage_num");
    if (exErr) throw exErr;
    const [options, mediaExtra] = await Promise.all([getCrmOptions(), getCrmMediaExtra().catch(() => [])]);
    const plan = planCrmImport(rows, { existing: (existingRows ?? []) as { id: string; title: string; stage: string; stage_num: number }[], options, mediaExtra, replace });

    const reports: ImportRowReport[] = plan.items.map((i) => i.report);
    if (!apply) {
      return NextResponse.json({ ok: true, preview: true, rows: reports, counts: plan.counts, newStages: plan.newStages, newOptions: plan.newOptions, existing: existingRows?.length ?? 0 });
    }

    // 선택지에 없던 발송 수단·고객군·유형은 선택지에 더한다(배지·필터가 바로 라벨을 보이게)
    const addOpts = plan.newOptions;
    if (addOpts.channels.length || addOpts.customers.length || addOpts.msgTypes.length) {
      await saveCrmOptions({ channels: [...options.channels, ...addOpts.channels], customers: [...options.customers, ...addOpts.customers], msgTypes: [...options.msgTypes, ...addOpts.msgTypes] });
    }
    let deleted = 0;
    if (replace) {
      const { error } = await sb.from("crm_messages").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) throw error;
      deleted = existingRows?.length ?? 0;
    }
    // 컬럼 폴백 계층 — 첫 성공 계층을 기억해 나머지 줄은 바로 그 계층으로
    let tierIdx = 0;
    let inserted = 0, updated = 0;
    const failed: string[] = [];
    for (const it of plan.items) {
      if (it.report.action === "skip") continue;
      let done = false;
      for (let t = tierIdx; t < TIERS.length && !done; t++) {
        const tier = TIERS[t];
        const row = toRow(it.input, tier);
        const res = it.existingId && !replace
          ? await sb.from("crm_messages").update({ ...row, updated_at: new Date().toISOString() }).eq("id", it.existingId).select("id").single()
          : await sb.from("crm_messages").insert(row).select("id").single();
        if (!res.error) { done = true; tierIdx = t; if (it.existingId && !replace) updated++; else inserted++; break; }
        const miss = missing(res.error);
        if (!miss.fields && !miss.dates && !miss.triggers) { failed.push(`${it.report.row}행 ${it.report.title}: ${extractErrorMsg(res.error, "저장 실패")}`); break; }
      }
      if (!done && !failed.some((f) => f.startsWith(`${it.report.row}행`))) failed.push(`${it.report.row}행 ${it.report.title}: 저장 실패`);
    }
    return NextResponse.json({ ok: true, preview: false, inserted, updated, deleted, skipped: plan.counts.skip, failed, rows: reports, newStages: plan.newStages, newOptions: plan.newOptions });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "가져오기 실패") }, { status: 500 });
  }
}
