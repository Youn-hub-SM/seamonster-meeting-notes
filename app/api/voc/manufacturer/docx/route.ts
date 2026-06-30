import { NextRequest, NextResponse } from "next/server";
import { Document, Packer, Paragraph, TextRun, AlignmentType } from "docx";
import { extractErrorMsg } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/voc/manufacturer/docx { month, recipient, draft } — 편집한 '고객 반응' 초안을 Word(.docx)로.
//  초안 텍스트 구조: 제목 / "1." 섹션 / "가." 소제목 / "- " 불릿(들여쓰기 = 하위) / 일반 문단.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { month?: string; recipient?: string; draft?: string };
    const draft = String(body.draft || "").trim();
    if (!draft) return NextResponse.json({ ok: false, error: "내용이 비어 있습니다. 먼저 초안을 생성하세요." }, { status: 400 });
    const recipient = String(body.recipient || "").slice(0, 100);
    const month = /^\d{4}-\d{2}$/.test(String(body.month || "")) ? String(body.month) : "";

    const paras: Paragraph[] = [];
    let titleDone = false;
    for (const raw of draft.split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, "");
      const trimmed = line.trim();
      if (!trimmed) { paras.push(new Paragraph({ children: [] })); continue; }

      if (!titleDone) {
        titleDone = true;
        paras.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: trimmed, bold: true, size: 32 })] }));
        if (recipient) paras.push(new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 160 }, children: [new TextRun({ text: `수신: ${recipient}`, size: 18, color: "666666" })] }));
        continue;
      }
      if (/^\d+\.\s/.test(trimmed)) {
        paras.push(new Paragraph({ spacing: { before: 240, after: 80 }, children: [new TextRun({ text: trimmed, bold: true, size: 26 })] }));
      } else if (/^[가-힣]\.\s/.test(trimmed)) {
        paras.push(new Paragraph({ spacing: { before: 100, after: 40 }, children: [new TextRun({ text: trimmed, bold: true, size: 23 })] }));
      } else if (/^-\s/.test(trimmed)) {
        const sub = /^\s{2,}/.test(line);
        paras.push(new Paragraph({ bullet: { level: sub ? 1 : 0 }, children: [new TextRun({ text: trimmed.replace(/^-\s*/, ""), size: 22 })] }));
      } else if (/^\s{2,}/.test(line)) {
        paras.push(new Paragraph({ bullet: { level: 1 }, children: [new TextRun({ text: trimmed, size: 22 })] }));
      } else {
        paras.push(new Paragraph({ children: [new TextRun({ text: trimmed, size: 22 })] }));
      }
    }

    const doc = new Document({
      styles: { default: { document: { run: { font: "맑은 고딕", size: 22 } } } },
      sections: [{ children: paras }],
    });
    const buf = await Packer.toBuffer(doc);
    const fname = encodeURIComponent(`씨몬스터_고객반응${month ? "_" + month : ""}.docx`);
    return new NextResponse(buf as unknown as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename*=UTF-8''${fname}`,
      },
    });
  } catch (err) {
    console.error("[voc/manufacturer/docx]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "Word 생성 실패") }, { status: 500 });
  }
}
