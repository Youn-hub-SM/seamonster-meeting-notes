import { NextRequest, NextResponse } from "next/server";
import { Document, Packer, Paragraph, TextRun, AlignmentType, ImageRun, Table, TableRow, TableCell, WidthType, BorderStyle } from "docx";
import { extractErrorMsg } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/voc/manufacturer/docx { month, recipient, draft, images?, tables? } — 편집한 '고객 반응' 리포트를 Word(.docx)로.
//  텍스트 구조: 제목 / "1." 섹션 / "가." 소제목 / "- " 불릿(들여쓰기 = 하위) / 일반 문단.
//  2026-11-02: 화면이 섹션 뒤에 끼운 자리표시 줄 "[[chart:키]]" → images 의 PNG(브라우저가 SVG 차트를 그린 것), "[[table:키]]" → tables 의 표.
//   서버에 이미지 라이브러리·한글 폰트 없이 간다 — 차트 그림은 브라우저 canvas 가 만든다. 짝이 없는 자리표시는 조용히 뺀다.
type Img = { key: string; png: string; width: number; height: number };   // png = data:image/png;base64,…
type Tbl = { key: string; title?: string; head: string[]; rows: string[][]; numCols?: number[] }; // numCols = 오른쪽 정렬 열 번호
const MAX_IMG = 12, MAX_IMG_BYTES = 2_500_000, MAX_TBL = 8, MAX_ROWS = 200;
const DOC_W = 9000; // 본문 폭(DXA ≈ 15.9cm) — 표·그림 폭 기준

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { month?: string; recipient?: string; draft?: string; images?: Img[]; tables?: Tbl[] };
    const draft = String(body.draft || "").trim();
    if (!draft) return NextResponse.json({ ok: false, error: "내용이 비어 있습니다. 먼저 리포트를 생성하세요." }, { status: 400 });
    const recipient = String(body.recipient || "").slice(0, 100);
    const month = /^\d{4}-\d{2}$/.test(String(body.month || "")) ? String(body.month) : "";

    const images = new Map<string, { data: Buffer; width: number; height: number }>();
    for (const im of (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMG)) {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(im?.png || ""));
      if (!m || !im.key) continue;
      const data = Buffer.from(m[1], "base64");
      if (!data.length || data.length > MAX_IMG_BYTES) continue;
      // 폭을 본문 폭 안으로(px 기준 600 = 약 15.9cm). 비율 유지.
      const w0 = Math.max(1, Number(im.width) || 600), h0 = Math.max(1, Number(im.height) || 300);
      const width = Math.min(600, w0), height = Math.round((h0 * width) / w0);
      images.set(String(im.key), { data, width, height });
    }
    const tables = new Map<string, Tbl>();
    for (const t of (Array.isArray(body.tables) ? body.tables : []).slice(0, MAX_TBL)) {
      if (!t?.key || !Array.isArray(t.head) || !Array.isArray(t.rows)) continue;
      tables.set(String(t.key), { key: String(t.key), title: t.title ? String(t.title) : undefined, head: t.head.map(String), rows: t.rows.slice(0, MAX_ROWS).map((r) => (Array.isArray(r) ? r.map(String) : [])), numCols: Array.isArray(t.numCols) ? t.numCols.map(Number) : [] });
    }

    const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" } as const;
    const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };
    const makeTable = (t: Tbl): (Paragraph | Table)[] => {
      const n = Math.max(1, t.head.length);
      const colW = Math.floor(DOC_W / n);
      const cell = (text: string, i: number, head: boolean) => new TableCell({
        borders, width: { size: colW, type: WidthType.DXA },
        shading: head ? { fill: "F2F2F2" } : undefined,
        children: [new Paragraph({ alignment: t.numCols?.includes(i) && !head ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [new TextRun({ text, bold: head, size: 20 })] })],
      });
      const out: (Paragraph | Table)[] = [];
      if (t.title) out.push(new Paragraph({ spacing: { before: 120, after: 60 }, children: [new TextRun({ text: t.title, bold: true, size: 22 })] }));
      out.push(new Table({
        width: { size: DOC_W, type: WidthType.DXA }, columnWidths: Array(n).fill(colW),
        rows: [new TableRow({ tableHeader: true, children: t.head.map((h, i) => cell(h, i, true)) }), ...t.rows.map((r) => new TableRow({ children: t.head.map((_, i) => cell(r[i] ?? "", i, false)) }))],
      }));
      out.push(new Paragraph({ children: [] }));
      return out;
    };

    const paras: (Paragraph | Table)[] = [];
    let titleDone = false;
    for (const raw of draft.split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, "");
      const trimmed = line.trim();
      if (!trimmed) { paras.push(new Paragraph({ children: [] })); continue; }

      const ph = /^\[\[(chart|table):([A-Za-z0-9_-]+)\]\]$/.exec(trimmed);
      if (ph) {
        if (ph[1] === "chart") {
          const im = images.get(ph[2]);
          if (im) paras.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 160 }, children: [new ImageRun({ type: "png", data: im.data, transformation: { width: im.width, height: im.height } })] }));
        } else {
          const t = tables.get(ph[2]);
          if (t) paras.push(...makeTable(t));
        }
        continue;
      }
      if (!titleDone) {
        titleDone = true;
        paras.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: trimmed, bold: true, size: 36 })] }));
        if (recipient) paras.push(new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 160 }, children: [new TextRun({ text: `수신: ${recipient}`, size: 18, color: "666666" })] }));
        continue;
      }
      if (/^\d+\.\s/.test(trimmed)) {
        paras.push(new Paragraph({ spacing: { before: 280, after: 90 }, children: [new TextRun({ text: trimmed, bold: true, size: 30 })] }));
      } else if (/^[가-힣]\.\s/.test(trimmed)) {
        paras.push(new Paragraph({ spacing: { before: 140, after: 50 }, children: [new TextRun({ text: trimmed, bold: true, size: 26 })] }));
      } else if (/^-\s/.test(trimmed)) {
        const sub = /^\s{2,}/.test(line);
        const body = trimmed.replace(/^-\s*/, "");
        const lab = /^([^:：]{1,24})\s*[:：]\s*(.*)$/.exec(body); // "라벨 : 내용" — 라벨 굵게(화면과 같은 규칙)
        paras.push(new Paragraph({ bullet: { level: sub ? 1 : 0 }, children: lab ? [new TextRun({ text: `${lab[1].trim()} : `, bold: true, size: 22 }), new TextRun({ text: lab[2], size: 22 })] : [new TextRun({ text: body, size: 22 })] }));
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
