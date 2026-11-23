// .xlsx 를 라이브러리 없이 읽는다 — 서버 전용(node:zlib). ExcelJS 가 읽지 못하는 파일을 위한 둘째 길.
//
//  세콤 출근 기록 엑셀이 그런 파일이다(2026-11-23 실물 확인): 태그에 접두사가 붙고(<x:row>), 칸 주소(r="A1")와
//  sharedStrings 가 없고, 글자는 inlineStr 로 들어 있다. 규격에는 맞지만 ExcelJS 는 "sheets" 를 찾지 못해 던진다.
//  여기서는 값만 읽는다(서식·수식·날짜 서식은 보지 않는다 — 글자와 숫자 그대로).
//  압축을 푼 크기를 제한한다(작은 파일에 큰 내용을 숨긴 파일을 막는다).

import { inflateRawSync } from "node:zlib";

export type PlainCell = string | number | null;
export type PlainSheet = { name: string; grid: PlainCell[][] };

const MAX_ENTRY = 40 * 1024 * 1024;   // 파일 하나를 푼 크기
const MAX_ROWS = 20000, MAX_COLS = 200;

// zip 안의 파일들: 이름 → 내용. 가운데 목록(central directory)을 따라 읽는다.
function unzip(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip 이 아닙니다");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen).replace(/^\//, "");
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    if (usize > MAX_ENTRY) throw new Error("파일이 너무 큽니다");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    out.set(name, method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_ENTRY }) : Buffer.alloc(0));
  }
  return out;
}

const unescapeXml = (s: string): string => s
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const attr = (tag: string, name: string): string => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
// <t>…</t> 들을 이어 붙인다(rich text 는 조각이 여럿이다). 접두사가 있어도 없어도.
//  속성 묶음은 짧게 잡는다(`[^>]*?`) — 길게 잡으면 `<c s="3" />` 같은 빈 태그의 `/` 까지 삼켜 다음 칸과 한 칸으로 합쳐진다.
const textOf = (xml: string): string => [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)].map((m) => unescapeXml(m[1] || "")).join("");
// "BC12" → 열 번호(0부터)
const colOf = (ref: string): number => { let n = 0; for (const ch of ref.replace(/\d/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<(?:\w+:)?si(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)].map((m) => textOf(m[1] || ""));
}

function gridOf(xml: string, shared: string[]): PlainCell[][] {
  const grid: PlainCell[][] = [];
  let rowNo = 0;
  for (const rm of xml.matchAll(/<(?:\w+:)?row(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const r = Number(attr(rm[1] || "", "r"));
    rowNo = r > 0 ? r : rowNo + 1;                       // 줄 번호가 없으면 차례대로
    if (rowNo > MAX_ROWS) throw new Error("줄이 너무 많습니다");
    const line: PlainCell[] = [];
    let colNo = -1;
    for (const cm of (rm[2] || "").matchAll(/<(?:\w+:)?c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const tag = cm[1] || "", inner = cm[2] || "";
      const ref = attr(tag, "r");
      colNo = ref ? colOf(ref) : colNo + 1;              // 칸 주소가 없으면 차례대로
      if (colNo < 0 || colNo >= MAX_COLS) continue;
      const type = attr(tag, "t");
      const v = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
      let value: PlainCell = null;
      if (type === "inlineStr") value = textOf(inner);
      else if (type === "s") value = v != null ? shared[Number(v)] ?? "" : null;
      else if (type === "str" || type === "e") value = v != null ? unescapeXml(v) : null;
      else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
      else if (v != null && v !== "") { const num = Number(v); value = Number.isFinite(num) ? num : unescapeXml(v); }
      else if (/<(?:\w+:)?is[\s>]/.test(inner)) value = textOf(inner);
      line[colNo] = value === "" ? null : value;
    }
    for (let j = 0; j < line.length; j++) if (line[j] === undefined) line[j] = null;
    grid[rowNo - 1] = line;
  }
  for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
  return grid;
}

// .xlsx(Buffer) → 시트들(파일에 적힌 차례). 읽지 못하면 던진다.
export function readPlainXlsx(buf: Buffer): PlainSheet[] {
  const files = unzip(buf, (n) => n === "xl/workbook.xml" || n === "xl/sharedStrings.xml" || n === "xl/_rels/workbook.xml.rels" || /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  const wb = files.get("xl/workbook.xml")?.toString("utf8");
  if (!wb) throw new Error("workbook 이 없습니다");
  const shared = sharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8"));
  // 관계 파일: r:id → 시트 파일
  const rels = new Map<string, string>();
  for (const m of (files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") || "").matchAll(/<(?:\w+:)?Relationship(\s[^>]*)\/?>/g)) {
    const target = attr(m[1], "Target").replace(/^\//, "");
    rels.set(attr(m[1], "Id"), target.startsWith("xl/") ? target : `xl/${target}`);
  }
  const out: PlainSheet[] = [];
  let i = 0;
  for (const m of wb.matchAll(/<(?:\w+:)?sheet(\s[^>]*)\/?>/g)) {
    i++;
    const path = rels.get(attr(m[1], "(?:\\w+:)?id")) || `xl/worksheets/sheet${i}.xml`;
    const xml = files.get(path)?.toString("utf8");
    if (xml == null) continue;
    out.push({ name: unescapeXml(attr(m[1], "name")) || `Sheet${i}`, grid: gridOf(xml, shared) });
  }
  if (out.length === 0) throw new Error("시트가 없습니다");
  return out;
}
