// 회사 공용 문서(SharePoint·OneDrive) 검색·읽기 — AI 비서 docs_* 도구와 관리자 › 설정 › 연결의 'Microsoft 365 문서' 카드가 쓴다(2026-10-25).
//  읽을 곳(사이트 주소 목록)은 kv 'ms365_sources' — 관리자가 설정 화면에서 넣는다. 자격(env)은 msgraph.ts.
//  문서 본문은 서버에서 글로 바꿔 모델에 넘긴다: docx·pptx 는 zip 안 XML, xlsx 는 exceljs, pdf 는 unpdf,
//  doc·xls·ppt 같은 옛 형식은 Graph 의 PDF 변환을 거친다. 쓰기는 없다(대표 결정: 읽기만).

import JSZip from "jszip";
import ExcelJS from "exceljs";
import { getKv, setKv } from "./b2b-settings";
import { graphDownload, getItem, isMsConfigured, itemPath, listChildren, listDrives, listSitePages, resolveSite, searchDrive, type GraphDrive, type GraphItem, type GraphSite, type GraphSitePage } from "./msgraph";

export type DocSource = { url: string; label: string };
const KV_SOURCES = "ms365_sources";

export async function getDocSources(): Promise<DocSource[]> {
  try {
    const raw = await getKv(KV_SOURCES);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    return arr.map((s) => ({ url: String((s as DocSource).url || "").trim(), label: String((s as DocSource).label || "").trim() })).filter((s) => s.url);
  } catch { return []; }
}
export async function setDocSources(list: DocSource[]): Promise<void> {
  await setKv(KV_SOURCES, JSON.stringify(list.map((s) => ({ url: s.url.trim(), label: s.label.trim() })).filter((s) => s.url).slice(0, 20)));
}

// ── 사이트 → 드라이브 해석(1시간 캐시) ──
export type ResolvedSource = DocSource & { site: GraphSite; drives: GraphDrive[]; error?: string };
let resolvedCache: { at: number; key: string; list: ResolvedSource[] } | null = null;

export async function resolveSources(opts?: { force?: boolean }): Promise<ResolvedSource[]> {
  const sources = await getDocSources();
  const key = JSON.stringify(sources);
  if (!opts?.force && resolvedCache && resolvedCache.key === key && Date.now() - resolvedCache.at < 3600_000) return resolvedCache.list;
  const list: ResolvedSource[] = [];
  for (const s of sources) {
    try {
      const site = await resolveSite(s.url);
      // 시스템 라이브러리(앱 패키지·클라이언트 자산·스타일·양식·사이트 자산·사이트 페이지 드라이브)는 검색 대상이 아니다 — 매뉴얼 사이트에서 500 을 냈다(2026-10-26)
      const SYSTEM_LIB = /^(SharePoint용 앱|Apps for SharePoint|클라이언트 측 자산|Client Side Assets|스타일 라이브러리|Style Library|양식 서식 파일|Form Templates|사이트 자산|Site Assets|사이트 페이지|Site Pages|Teams Wiki Data|Converted Forms|변환된 양식)$/i;
      const drives = (await listDrives(site.id)).filter((d) => (!d.driveType || d.driveType === "documentLibrary" || d.driveType === "business") && !SYSTEM_LIB.test(d.name || "")).slice(0, 5);
      list.push({ ...s, label: s.label || site.name, site, drives });
    } catch (e) {
      list.push({ ...s, site: { id: "", name: s.label || s.url, webUrl: s.url }, drives: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  resolvedCache = { at: Date.now(), key, list };
  return list;
}

const MAX_BYTES = 25 * 1024 * 1024;
const EXT_TEXT = /\.(txt|md|csv|json|log|xml|html?)$/i;
const EXT_CONVERT = /\.(doc|xls|ppt|rtf|odt|ods|odp)$/i; // Graph 가 PDF 로 바꿔 줄 수 있는 옛 형식

export const docRef = (it: GraphItem, driveId?: string) => `${driveId || it.parentReference?.driveId || ""}:${it.id}`;
function parseRef(ref: string): { driveId: string; itemId: string } {
  const i = ref.indexOf(":");
  if (i <= 0 || i === ref.length - 1) throw new Error("ref 는 docs_search 결과의 'ref' 값(드라이브:항목) 그대로여야 합니다.");
  return { driveId: ref.slice(0, i), itemId: ref.slice(i + 1) };
}

export type DocHit = { ref: string; name: string; path: string; source: string; kind: "file" | "folder" | "page"; modified: string; sizeKb: number; url: string };

// ── 사이트 페이지(매뉴얼 사이트) — 사이트당 한 번 읽어 10분 캐시, 검색은 제목·요약·본문 글자 포함으로 ──
type PageText = GraphSitePage & { text: string };
const pageCache = new Map<string, { at: number; pages: PageText[] }>();
const htmlToText = (html: string) => html
  .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<\/t[dh]>/gi, "\t")
  .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
async function sitePages(src: ResolvedSource): Promise<PageText[]> {
  const c = pageCache.get(src.site.id);
  if (c && Date.now() - c.at < 600_000) return c.pages;
  const raw = await listSitePages(src.site.id);
  const pages = raw.filter((p) => !/^(Home|SCHome|Template-[^.]*)\.aspx$/i.test(p.fileName)).map((p) => ({ ...p, text: htmlToText(p.canvas) })).filter((p) => p.text.length >= 20);
  pageCache.set(src.site.id, { at: Date.now(), pages });
  return pages;
}
const pageHit = (p: PageText, src: ResolvedSource): DocHit => ({ ref: `page:${src.site.id}:${p.id}`, name: p.title, path: `페이지/${p.fileName}`, source: src.label, kind: "page", modified: p.modified, sizeKb: Math.round(p.text.length / 1024), url: p.webUrl });
const toHit = (it: GraphItem, src: ResolvedSource, driveId: string): DocHit => ({
  ref: docRef(it, driveId), name: it.name, path: itemPath(it), source: src.label,
  kind: it.folder ? "folder" : "file", modified: (it.lastModifiedDateTime || "").slice(0, 10), sizeKb: Math.round((it.size || 0) / 1024), url: it.webUrl || "",
});

function matchSource(list: ResolvedSource[], source?: string | null): ResolvedSource[] {
  if (!source?.trim()) return list;
  const q = source.trim().toLowerCase();
  const hit = list.filter((s) => s.label.toLowerCase().includes(q) || s.site.name.toLowerCase().includes(q) || s.url.toLowerCase().includes(q));
  if (!hit.length) throw new Error(`'${source}' 라는 문서함이 없습니다. 등록된 곳: ${list.map((s) => s.label).join(", ") || "(없음)"}`);
  return hit;
}

// Graph 드라이브 검색(search(q=))이 실패할 때의 대체 — 폴더를 너비 우선으로 걸으며 이름에 검색어가 모두 들어간 파일·폴더를 고른다(2026-10-27).
//  팀즈 자료실에서 검색 끝점이 Graph 오류를 내서 비서가 폴더를 손으로 열어야 했다. 본문은 못 보지만 이름 적중은 챙긴다.
//  상한: 폴더 60개·항목 3,000개·12초 — 서버리스 한 번에 끝나게.
const WALK_FOLDERS = 60, WALK_ITEMS = 3000, WALK_MS = 12_000;
async function walkDriveByName(driveId: string, terms: string[], limit: number): Promise<{ items: GraphItem[]; partial: boolean }> {
  const out: GraphItem[] = [];
  const queue: string[] = [""];
  const t0 = Date.now();
  let folders = 0, scanned = 0, partial = false;
  while (queue.length && out.length < limit) {
    if (folders >= WALK_FOLDERS || scanned >= WALK_ITEMS || Date.now() - t0 > WALK_MS) { partial = true; break; }
    const path = queue.shift() as string;
    folders++;
    let kids: GraphItem[];
    try { kids = await listChildren(driveId, path, 200); } catch { partial = true; continue; }
    for (const it of kids) {
      scanned++;
      const name = (it.name || "").toLowerCase();
      if (terms.every((w) => name.includes(w))) out.push(it);
      if (it.folder && (it.folder.childCount ?? 1) > 0) queue.push(path ? `${path}/${it.name}` : it.name);
    }
  }
  return { items: out.slice(0, limit), partial: partial || queue.length > 0 };
}

export async function searchDocs(p: { query: string; source?: string | null; limit?: number }): Promise<{ hits: DocHit[]; note: string }> {
  if (!isMsConfigured()) throw new Error("Microsoft 365 가 연결되어 있지 않습니다(관리자가 Vercel 환경 변수 MS_TENANT_ID·MS_CLIENT_ID·MS_CLIENT_SECRET 를 넣어야 합니다).");
  const all = await resolveSources();
  if (!all.length) throw new Error("읽을 문서함이 등록되어 있지 않습니다(관리자 › 설정 › 연결 › Microsoft 365 문서).");
  const targets = matchSource(all, p.source);
  const limit = Math.min(Math.max(p.limit ?? 20, 1), 50);
  const hits: DocHit[] = [];
  const errs: string[] = [];
  const terms = p.query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const src of targets) {
    if (src.error) { errs.push(`${src.label}: ${src.error}`); continue; }
    for (const d of src.drives) {
      try { for (const it of await searchDrive(d.id, p.query, limit)) hits.push(toHit(it, src, d.id)); }
      catch (e) {
        // 검색 끝점 실패 → 폴더 걷기(이름 적중)로 대체. 본문 검색이 빠졌다는 것을 note 로 알려 비서가 docs_list 로 더 찾게 한다.
        const why = e instanceof Error ? e.message : String(e);
        try {
          const w = await walkDriveByName(d.id, terms, limit);
          for (const it of w.items) hits.push(toHit(it, src, d.id));
          errs.push(`${src.label}/${d.name}: 본문 검색 불가(${why.slice(0, 90)}) → 폴더를 훑어 이름이 맞는 ${w.items.length}건${w.partial ? "(일부 폴더만 봄)" : ""}`);
        } catch (e2) { errs.push(`${src.label}/${d.name}: ${why.slice(0, 120)} / 폴더 훑기도 실패(${e2 instanceof Error ? e2.message.slice(0, 80) : "오류"})`); }
      }
    }
    // 사이트 페이지(매뉴얼) — 모든 검색어가 제목·요약·본문 중 어딘가에 있으면 적중, 제목 적중을 앞으로
    try {
      const pages = await sitePages(src);
      const scored = pages.map((pg) => { const t = pg.title.toLowerCase(), d = pg.description.toLowerCase(), b = pg.text.toLowerCase(); const ok = terms.every((w) => t.includes(w) || d.includes(w) || b.includes(w)); return { pg, score: ok ? terms.filter((w) => t.includes(w)).length * 2 + terms.filter((w) => d.includes(w)).length : -1 }; }).filter((x) => x.score >= 0).sort((a, b) => b.score - a.score);
      for (const x of scored.slice(0, limit)) hits.push(pageHit(x.pg, src));
    } catch (e) { errs.push(`${src.label}/페이지: ${e instanceof Error ? e.message : String(e)}`); }
  }
  // 페이지(제목 적중 순)를 앞에, 파일은 최근 수정 순
  const pagesFirst = hits.filter((h) => h.kind === "page");
  const files = hits.filter((h) => h.kind !== "page").sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
  return { hits: [...pagesFirst, ...files].slice(0, limit), note: errs.length ? `일부 문서함은 검색이 제한됐습니다 — ${errs.join(" / ")}` : "" };
}

// 연결 확인용 — 드라이브마다 검색 끝점이 되는지 한 번 찔러 본다(안 되면 Graph 오류 원문을 돌려준다).
export async function probeDriveSearch(driveId: string): Promise<string> {
  try { await searchDrive(driveId, "a", 1); return "검색 OK"; }
  catch (e) { return `검색 실패: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`; }
}

export async function listDocs(p: { source?: string | null; path?: string | null }): Promise<{ hits: DocHit[]; where: string }> {
  if (!isMsConfigured()) throw new Error("Microsoft 365 가 연결되어 있지 않습니다.");
  const all = await resolveSources();
  if (!all.length) throw new Error("읽을 문서함이 등록되어 있지 않습니다(관리자 › 설정 › 연결 › Microsoft 365 문서).");
  const targets = matchSource(all, p.source);
  const hits: DocHit[] = [];
  const pageErrs: string[] = [];
  for (const src of targets) {
    if (src.error) throw new Error(`${src.label}: ${src.error}`);
    for (const d of src.drives) {
      try { for (const it of await listChildren(d.id, p.path || "")) hits.push(toHit(it, src, d.id)); }
      catch (e) { if (targets.length === 1 && src.drives.length === 1) throw e; }
    }
    if (!p.path) { try { for (const pg of await sitePages(src)) hits.push(pageHit(pg, src)); } catch (e) { pageErrs.push(`${src.label} 페이지: ${e instanceof Error ? e.message : String(e)}`); } }
  }
  return { hits: hits.slice(0, 200), where: `${targets.map((s) => s.label).join(", ")}${p.path ? ` / ${p.path}` : ""}${pageErrs.length ? ` (페이지 목록 오류: ${pageErrs.join(" / ")})` : ""}` };
}

// ── 본문 추출 ──
const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
const stripTags = (xml: string) => decodeXml(xml.replace(/<[^>]+>/g, ""));

async function docxText(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new Error("docx 안에 본문(word/document.xml)이 없습니다.");
  return stripTags(xml.replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<w:br\/>/g, "\n")).replace(/\n{3,}/g, "\n\n").trim();
}
async function pptxText(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const out: string[] = [];
  for (const n of names) {
    const xml = (await zip.file(n)!.async("string")).replace(/<\/a:p>/g, "\n");
    out.push(`[슬라이드 ${n.match(/\d+/)![0]}]\n${stripTags(xml).replace(/\n{2,}/g, "\n").trim()}`);
  }
  return out.join("\n\n");
}
async function xlsxText(bytes: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const out: string[] = [];
  wb.eachSheet((ws) => {
    const lines: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row, i) => {
      if (lines.length >= 500) return;
      const cells = (row.values as unknown[]).slice(1).map((v) => {
        if (v == null) return "";
        if (typeof v === "object") { const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[] }; if (o.richText) return o.richText.map((r) => r.text).join(""); if (o.result !== undefined) return String(o.result); if (o.text !== undefined) return String(o.text); if (v instanceof Date) return v.toISOString().slice(0, 10); }
        return String(v);
      });
      lines.push(`${i}\t${cells.join("\t")}`);
    });
    out.push(`[시트 ${ws.name}] (${ws.rowCount}행${ws.rowCount > 500 ? ", 앞 500행만" : ""})\n${lines.join("\n")}`);
  });
  return out.join("\n\n");
}
async function pdfText(bytes: Buffer): Promise<string> {
  const { extractText } = await import("unpdf");
  const r = await extractText(new Uint8Array(bytes), { mergePages: true });
  const text = Array.isArray(r.text) ? r.text.join("\n") : String(r.text || "");
  if (text.trim().length < 20) return `(PDF ${r.totalPages}쪽 — 글자가 없습니다. 스캔 이미지 PDF 로 보이며 본문을 읽을 수 없습니다.)`;
  return `(PDF ${r.totalPages}쪽)\n${text.trim()}`;
}

// 파일 바이트 → 글(형식은 이름의 확장자로). 로컬 검증용으로도 내보낸다.
export async function extractTextBytes(name: string, bytes: Buffer): Promise<string> {
  if (/\.docx$/i.test(name)) return docxText(bytes);
  if (/\.pptx$/i.test(name)) return pptxText(bytes);
  if (/\.xlsx$/i.test(name)) return xlsxText(bytes);
  if (/\.pdf$/i.test(name)) return pdfText(bytes);
  if (EXT_TEXT.test(name)) return bytes.toString("utf8");
  throw new Error(`읽을 수 없는 형식입니다(${name.split(".").pop()}). docx·pptx·xlsx·pdf·txt·csv·md 와 옛 doc·xls·ppt 만 읽습니다.`);
}

async function extractText(it: GraphItem, driveId: string): Promise<string> {
  const name = it.name || "";
  if ((it.size || 0) > MAX_BYTES) throw new Error(`파일이 너무 큽니다(${Math.round((it.size || 0) / 1024 / 1024)}MB, 상한 25MB).`);
  const path = `/drives/${driveId}/items/${it.id}`;
  if (EXT_CONVERT.test(name)) return pdfText((await graphDownload(path, { format: "pdf" })).bytes); // 옛 형식은 Graph 가 PDF 로 바꿔 준다
  return extractTextBytes(name, (await graphDownload(path)).bytes);
}

// 본문 캐시(같은 문서를 이어 읽을 때 다시 내려받지 않게) — 서버리스 인스턴스 안에서만, 10분
const textCache = new Map<string, { at: number; text: string; name: string; path: string; url: string }>();

export const DOC_PAGE_CHARS = 24_000;
export async function readDoc(p: { ref: string; offset?: number | null }): Promise<{ name: string; path: string; url: string; text: string; offset: number; total: number; next: number | null }> {
  if (!isMsConfigured()) throw new Error("Microsoft 365 가 연결되어 있지 않습니다.");
  if (p.ref.startsWith("page:")) {
    const [, siteId, itemId] = p.ref.split(":");
    const src = (await resolveSources()).find((s) => s.site.id === siteId);
    if (!src) throw new Error("이 페이지의 사이트가 등록되어 있지 않습니다.");
    const pg = (await sitePages(src)).find((x) => x.id === itemId);
    if (!pg) throw new Error("페이지를 찾지 못했습니다(ref 를 docs_search 결과에서 다시 가져오세요).");
    const full = pg.description ? `${pg.description}\n\n${pg.text}` : pg.text;
    const offset = Math.max(0, Math.min(Number(p.offset) || 0, full.length));
    const slice = full.slice(offset, offset + DOC_PAGE_CHARS);
    return { name: pg.title, path: `${src.label} / 페이지 / ${pg.fileName}`, url: pg.webUrl, text: slice, offset, total: full.length, next: offset + DOC_PAGE_CHARS < full.length ? offset + DOC_PAGE_CHARS : null };
  }
  const { driveId, itemId } = parseRef(p.ref);
  let c = textCache.get(p.ref);
  if (!c || Date.now() - c.at > 600_000) {
    const it = await getItem(driveId, itemId);
    if (it.folder) throw new Error(`'${it.name}' 은 폴더입니다 — docs_list 로 안을 보세요.`);
    const text = await extractText(it, driveId);
    c = { at: Date.now(), text, name: it.name, path: itemPath(it), url: it.webUrl || "" };
    textCache.set(p.ref, c);
  }
  const offset = Math.max(0, Math.min(Number(p.offset) || 0, c.text.length));
  const slice = c.text.slice(offset, offset + DOC_PAGE_CHARS);
  const next = offset + DOC_PAGE_CHARS < c.text.length ? offset + DOC_PAGE_CHARS : null;
  return { name: c.name, path: c.path, url: c.url, text: slice, offset, total: c.text.length, next };
}

// 비서 지침용 — 등록된 문서함 목록(턴마다 붙는 블록). 없으면 빈 문자열.
export async function docsPromptBlock(): Promise<string> {
  if (!isMsConfigured()) return "";
  const s = await getDocSources();
  if (!s.length) return "";
  return `[회사 문서함(Microsoft 365) — docs_search·docs_list·docs_read 로 읽는 곳] ${s.map((x) => x.label || x.url).join(", ")}. 문서함의 파일뿐 아니라 사이트 페이지(매뉴얼)도 검색·읽기 대상입니다 — 업무 절차·기준·역할 질문은 먼저 docs_search 로 매뉴얼 페이지를 찾습니다.`;
}
