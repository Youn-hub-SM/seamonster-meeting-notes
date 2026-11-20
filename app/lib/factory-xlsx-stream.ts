// 큰 엑셀(.xlsx) 첫 시트를 한 줄씩 읽는다 — 파도소리 예상 화면의 [데이터 올리기] 전용.
//  ERP 에서 받은 파일은 8만 줄 × 38칸(압축을 풀면 50MB 안팎)이라 exceljs 로 통째로 올리면 브라우저가 멈춘다.
//  xlsx 는 zip 이므로 시트 XML 만 골라 DecompressionStream 으로 흘려 읽고, 줄 단위로 넘긴다(외부 라이브러리 없음).
//  브라우저와 Node(18+) 양쪽에서 돈다 — 순수 Web API(Blob · DecompressionStream · TextDecoder)만 쓴다.

export type XlsxCell = string | number | null;

type ZipEntry = { name: string; method: number; compSize: number; offset: number };

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function bytes(file: Blob, from: number, to: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(from, to).arrayBuffer());
}

// zip 목차(central directory) — 파일 끝의 EOCD 에서 위치를 얻는다
async function zipEntries(file: Blob): Promise<ZipEntry[]> {
  const tailLen = Math.min(file.size, 66000);
  const tail = await bytes(file, file.size - tailLen, file.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("엑셀(.xlsx) 파일이 아닙니다.");
  const cdSize = u32(tail, eocd + 12), cdOff = u32(tail, eocd + 16);
  const cd = await bytes(file, cdOff, cdOff + cdSize);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let p = 0; p + 46 <= cd.length && u32(cd, p) === 0x02014b50;) {
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    out.push({ name: dec.decode(cd.subarray(p + 46, p + 46 + nameLen)), method: u16(cd, p + 10), compSize: u32(cd, p + 20), offset: u32(cd, p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function entryStream(file: Blob, e: ZipEntry): Promise<ReadableStream<Uint8Array>> {
  const head = await bytes(file, e.offset, e.offset + 30);
  if (u32(head, 0) !== 0x04034b50) throw new Error("엑셀 파일이 손상됐습니다.");
  const start = e.offset + 30 + u16(head, 26) + u16(head, 28);
  const raw = file.slice(start, start + e.compSize).stream() as ReadableStream<Uint8Array>;
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new Error("지원하지 않는 압축 방식의 엑셀입니다.");
  // lib.dom 의 DecompressionStream 타입이 BufferSource 로 잡혀 있어 캐스팅한다(런타임은 Uint8Array 그대로)
  return raw.pipeThrough(new DecompressionStream("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>);
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  if (s.indexOf("&") < 0 && s.indexOf("_x") < 0) return s;
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, g: string) =>
      g[0] === "#" ? String.fromCodePoint(g[1] === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)) : ENT[g])
    .replace(/_x000[dD]_/g, "");
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  const r = stream.getReader();
  let s = "";
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    s += dec.decode(value, { stream: true });
  }
  return s + dec.decode();
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si\s*\/>|<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[1] == null) { out.push(""); continue; }
    let t = "";
    const tr = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let x: RegExpExecArray | null;
    while ((x = tr.exec(m[1]))) t += x[1];
    out.push(unescapeXml(t));
  }
  return out;
}

function colIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

const CELL_RE = /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

function parseRow(xml: string, shared: string[]): XlsxCell[] {
  const cells: XlsxCell[] = [];
  CELL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CELL_RE.exec(xml))) {
    const body = m[3];
    if (body == null) continue;
    const idx = colIndex(m[1]);
    const type = /\bt="([a-zA-Z]+)"/.exec(m[2])?.[1] || "n";
    let v: XlsxCell = null;
    if (type === "inlineStr") {
      const t = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(body);
      v = t ? unescapeXml(t[1]) : "";
    } else {
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (raw == null) continue;
      if (type === "s") v = shared[Number(raw)] ?? "";
      else if (type === "str" || type === "e") v = unescapeXml(raw);
      else if (type === "b") v = raw === "1" ? 1 : 0;
      else { const n = Number(raw); v = Number.isFinite(n) ? n : unescapeXml(raw); }
    }
    while (cells.length < idx) cells.push(null);
    cells[idx] = v;
  }
  return cells;
}

// 첫 시트의 모든 줄을 순서대로 넘긴다(1번째 호출 = 머리글 줄). onProgress 는 0~1.
export async function readXlsxRows(
  file: Blob,
  onRow: (cells: XlsxCell[], rowNo: number) => void,
  onProgress?: (ratio: number) => void,
): Promise<void> {
  const entries = await zipEntries(file);
  const sheet = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => Number(/\d+/.exec(a.name.slice(13))![0]) - Number(/\d+/.exec(b.name.slice(13))![0]))[0];
  if (!sheet) throw new Error("시트를 찾을 수 없습니다.");
  const ss = entries.find((e) => e.name === "xl/sharedStrings.xml");
  const shared = ss ? parseSharedStrings(await readAll(await entryStream(file, ss))) : [];

  const reader = (await entryStream(file, sheet)).getReader();
  const dec = new TextDecoder();
  let buf = "", rowNo = 0, fed = 0, tick = 0;
  const drain = () => {
    let from = 0;
    for (;;) {
      const end = buf.indexOf("</row>", from);
      if (end < 0) break;
      const start = buf.indexOf("<row", from);
      if (start >= 0 && start < end) onRow(parseRow(buf.slice(start, end), shared), ++rowNo);
      from = end + 6;
    }
    buf = buf.slice(from);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    fed += value.length;
    drain();
    // 화면이 굳지 않게 가끔 양보한다. 진행률은 풀린 XML 길이 ÷ (압축 크기 × 약 9배) 어림값
    if (++tick % 40 === 0) {
      onProgress?.(Math.min(0.99, fed / (sheet.compSize * 9)));
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  buf += dec.decode();
  drain();
  onProgress?.(1);
}

// 엑셀 날짜 일련번호 → 'YYYY-MM-DD' (1900 날짜 체계)
export function excelDate(v: XlsxCell): string | null {
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400e3)).toISOString().slice(0, 10);
  if (typeof v === "string") { const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(v.trim()); if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`; }
  return null;
}
