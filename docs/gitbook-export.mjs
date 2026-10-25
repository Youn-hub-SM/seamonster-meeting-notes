// GitBook → 내보내기 (2026-10-26) — SharePoint 매뉴얼 사이트 이전 1단계. Node 18+ 로 실행, 외부 패키지 없음.
//  토큰: C:\Users\<me>\.secrets\gitbook-token.txt (GitBook → 계정 설정 → Developer → API 토큰). 채팅·깃에 올리지 않는다.
//  사용:
//    node docs/gitbook-export.mjs list                       조직·스페이스·페이지 트리 요약
//    node docs/gitbook-export.mjs export <spaceId> [출력폴더]  스페이스 하나를 HTML 페이지 + 이미지 + pages.json 으로
//  출력(기본 C:\Users\<me>\Desktop\claude\gitbook-export\<스페이스제목>\):
//    pages.json   [{ id, title, group, file, order, depth, children:[...] }] — SharePoint 가져오기 스크립트가 읽는다
//    pages/<file>.html, images/<name>          GitBook 전용 블록(hint·tabs·expand)은 평범한 HTML 로 바꾼다
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";

const API = "https://api.gitbook.com/v1";
const tokenPath = join(homedir(), ".secrets", "gitbook-token.txt");
let H = {};
function auth() {
  if (!existsSync(tokenPath)) { console.error(`토큰 파일이 없습니다: ${tokenPath}`); process.exit(1); }
  H = { Authorization: `Bearer ${readFileSync(tokenPath, "utf8").trim()}` };
}

async function api(path) {
  const r = await fetch(`${API}${path}`, { headers: H });
  if (!r.ok) throw new Error(`${r.status} ${path}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function all(path) { // 페이징(next.page)
  const out = []; let next = path;
  while (next) { const j = await api(next); out.push(...(j.items || [])); next = j.next?.page ? `${path}${path.includes("?") ? "&" : "?"}page=${j.next.page}` : null; }
  return out;
}

// ── 마크다운 → HTML (GitBook 문법 포함, SharePoint 텍스트 웹 파트가 받아들이는 태그만) ──
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function inline(s, images) {
  s = esc(s).replace(/@@BR@@/g, "<br>");
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => { const name = images.add(url); return `<img src="@@IMG@@/${name}" alt="${alt.replace(/&lt;[^&]*&gt;/g, "").trim()}">`; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>").replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  return s;
}
export function mdToHtml(md, images, opts = {}) {
  // GitBook 내보내기 특유의 것: 머리 정보(--- description ---), HTML 엔티티(&#x20;), 백슬래시 이스케이프(\&), 줄 끝 \ = 줄바꿈
  md = md.replace(/\r/g, "").replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { const c = parseInt(h, 16); return c === 13 ? "" : c === 10 ? " " : String.fromCodePoint(c); })
    .replace(/&#(\d+);/g, (_, d) => { const c = Number(d); return c === 13 ? "" : c === 10 ? " " : String.fromCodePoint(c); })
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\\\n/g, "@@BR@@\n").replace(/\\([&_*#\[\]()`~>|-])/g, "$1");
  // 첫 제목이 페이지 제목과 같으면 뺀다(SharePoint 페이지 제목이 그 역할)
  if (opts.title) md = md.replace(new RegExp(`^\\s*#{1,2}\\s+${opts.title.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(\\n|$)`), "");
  // GitBook 블록 → 일반 마크다운
  md = md
    .replace(/\{%\s*hint\s+style="(\w+)"\s*%\}([\s\S]*?)\{%\s*endhint\s*%\}/g, (_, st, body) => `> **${({ info: "안내", warning: "주의", danger: "경고", success: "팁" })[st] || "안내"}**\n> ${body.trim().split("\n").join("\n> ")}\n`)
    .replace(/\{%\s*tabs\s*%\}|\{%\s*endtabs\s*%\}/g, "")
    .replace(/\{%\s*tab\s+title="([^"]*)"\s*%\}/g, "\n### $1\n").replace(/\{%\s*endtab\s*%\}/g, "\n")
    .replace(/\{%\s*embed\s+url="([^"]*)"\s*%\}/g, "[$1]($1)")
    .replace(/\{%\s*content-ref\s+url="([^"]*)"\s*%\}[\s\S]*?\{%\s*endcontent-ref\s*%\}/g, "[관련: $1]($1)")
    .replace(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g, "\n### $1\n$2\n")
    .replace(/<figure>[\s\S]*?<img[^>]*src="([^"]+)"[^>]*>[\s\S]*?(?:<figcaption>([\s\S]*?)<\/figcaption>)?[\s\S]*?<\/figure>/g, (_, src, cap) => `![${(cap || "").replace(/<[^>]+>/g, "").trim()}](${src})`)
    .replace(/\{%[^%]*%\}/g, "");
  const lines = md.split("\n"); const out = []; let i = 0;
  const flushPara = (buf) => { if (buf.length) { out.push(`<p>${inline(buf.join(" "), images)}</p>`); buf.length = 0; } };
  const para = [];
  while (i < lines.length) {
    const l = lines[i];
    let m;
    // SharePoint 텍스트 웹 파트의 '제목 1' 은 h2(목차 웹 파트는 h2·h3 를 모은다) — h1 은 h2 로, h4 까지만
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flushPara(para); const lv = Math.max(2, Math.min(m[1].length, 4)); out.push(`<h${lv}>${inline(m[2], images)}</h${lv}>`); i++; continue; }
    if (/^```/.test(l)) { flushPara(para); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre>${esc(buf.join("\n"))}</pre>`); continue; }
    if (/^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) {
      flushPara(para); const ordered = /^\s*\d+[.)]\s+/.test(l); const items = [];
      while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        if (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, "").replace(/^\[([ xX])\]\s*/, (_, c) => (c === " " ? "☐ " : "☑ ")));
        else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inline(t, images)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`); continue;
    }
    if (/^>/.test(l)) { flushPara(para); const buf = []; while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${mdToHtml(buf.join("\n"), images)}</blockquote>`); continue; }
    if (/^\|/.test(l) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara(para); const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim(), images));
      const head = cells(rows[0]); const body = rows.slice(2).map(cells);
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`); continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(l)) { flushPara(para); out.push("<hr>"); i++; continue; }
    if (/^\s*<(img|figure|iframe)/.test(l)) { flushPara(para); const src = l.match(/src="([^"]+)"/)?.[1]; if (src && /<img/.test(l)) out.push(`<p><img src="@@IMG@@/${images.add(src)}"></p>`); else if (src) out.push(`<p><a href="${src}">${src}</a></p>`); i++; continue; }
    if (!l.trim()) { flushPara(para); i++; continue; }
    para.push(l.trim()); i++;
  }
  flushPara(para);
  return out.join("\n");
}

// GitBook 문서 JSON(마크다운을 못 받을 때) → 텍스트 마크다운 근사
function docToMd(node, depth = 0) {
  if (!node) return "";
  if (node.type === "text") return (node.leaves || [{ text: node.text || "" }]).map((lf) => { let t = lf.text || ""; for (const m of lf.marks || []) { if (m.type === "bold") t = `**${t}**`; if (m.type === "italic") t = `*${t}*`; if (m.type === "code") t = `\`${t}\``; } return t; }).join("");
  const kids = (node.nodes || []).map((n) => docToMd(n, depth + 1)).join(node.object === "block" ? "\n" : "");
  switch (node.type) {
    case "heading-1": return `# ${kids}\n`; case "heading-2": return `## ${kids}\n`; case "heading-3": return `### ${kids}\n`;
    case "paragraph": return `${kids}\n`;
    case "list-unordered": return (node.nodes || []).map((li) => `- ${docToMd(li).trim()}`).join("\n") + "\n";
    case "list-ordered": return (node.nodes || []).map((li, k) => `${k + 1}. ${docToMd(li).trim()}`).join("\n") + "\n";
    case "list-item": return kids;
    case "link": return `[${kids}](${node.data?.ref?.url || node.data?.href || "#"})`;
    case "image": case "images": return `![](${node.data?.ref?.url || node.data?.src || ""})\n`;
    case "hint": return `{% hint style="${node.data?.style || "info"}" %}\n${kids}\n{% endhint %}\n`;
    case "code": return "```\n" + (node.nodes || []).map((ln) => docToMd(ln)).join("\n") + "\n```\n";
    case "code-line": return kids;
    case "blockquote": return kids.split("\n").map((x) => `> ${x}`).join("\n") + "\n";
    case "table": return (node.nodes || []).map((r, ri) => "| " + (r.nodes || []).map((c) => docToMd(c).trim().replace(/\n/g, " ")).join(" | ") + " |" + (ri === 0 ? "\n|" + (r.nodes || []).map(() => " --- |").join("") : "")).join("\n") + "\n";
    default: return kids;
  }
}

const safeName = (s) => s.replace(/[\\/:*?"<>|#%&{}]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "page";

async function cmdList() {
  const orgs = await all("/orgs");
  for (const o of orgs) {
    console.log(`조직: ${o.title} (${o.id})`);
    const spaces = await all(`/orgs/${o.id}/spaces`);
    for (const s of spaces) {
      let n = 0; try { const c = await api(`/spaces/${s.id}/content`); const walk = (ps) => { for (const p of ps || []) { n++; walk(p.pages); } }; walk(c.pages); } catch { /* 권한 없음 */ }
      console.log(`  스페이스: ${s.title}  id=${s.id}  페이지 ${n}개  ${s.visibility || ""}`);
    }
  }
}

async function cmdExport(spaceId, outRoot) {
  const space = await api(`/spaces/${spaceId}`);
  const content = await api(`/spaces/${spaceId}/content`);
  const dir = join(outRoot || join(homedir(), "Desktop", "claude", "gitbook-export"), safeName(space.title));
  mkdirSync(join(dir, "pages"), { recursive: true }); mkdirSync(join(dir, "images"), { recursive: true });
  const images = { map: new Map(), add(url) { if (!this.map.has(url)) { const ext = (extname(url.split("?")[0]) || ".png").slice(0, 6); this.map.set(url, `img${this.map.size + 1}${ext}`); } return this.map.get(url); } };
  const used = new Set();
  const tree = [];
  async function walk(pages, parentTitles, depth, into) {
    for (const [k, p] of (pages || []).entries()) {
      const title = p.title || "(제목 없음)";
      let html = "";
      if (p.kind !== "group") {
        try {
          const j = await api(`/spaces/${spaceId}/content/page/${p.id}?format=markdown`);
          const md = typeof j.markdown === "string" ? j.markdown : docToMd(j.document);
          html = mdToHtml(md, images, { title });
        } catch (e) { html = `<p>(본문을 가져오지 못했습니다: ${esc(String(e.message))})</p>`; }
      }
      let file = safeName([...parentTitles.slice(-1), title].join(" - ")); let c = 1; const base = file; while (used.has(file)) file = `${base}-${++c}`; used.add(file);
      if (html) writeFileSync(join(dir, "pages", `${file}.html`), html, "utf8");
      const node = { id: p.id, title, kind: p.kind || "sheet", path: p.path || "", file: html ? `${file}.html` : null, order: k, depth, children: [] };
      into.push(node);
      await walk(p.pages, [...parentTitles, title], depth + 1, node.children);
      process.stdout.write(`${"  ".repeat(depth)}${html ? "페이지" : "그룹  "} ${title}\n`);
    }
  }
  await walk(content.pages, [], 0, tree);
  // 이미지 내려받기
  let okImg = 0;
  for (const [url, name] of images.map) {
    try { const r = await fetch(url, { headers: H }); if (!r.ok) throw new Error(String(r.status)); writeFileSync(join(dir, "images", name), Buffer.from(await r.arrayBuffer())); okImg++; }
    catch { try { const r = await fetch(url); if (r.ok) { writeFileSync(join(dir, "images", name), Buffer.from(await r.arrayBuffer())); okImg++; } } catch { /* 건너뜀 */ } }
  }
  writeFileSync(join(dir, "pages.json"), JSON.stringify({ space: space.title, spaceId, exportedAt: new Date().toISOString(), pages: tree }, null, 2), "utf8");
  console.log(`\n완료: ${dir}\n이미지 ${okImg}/${images.map.size}`);
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (cmd === "list") { auth(); await cmdList(); }
  else if (cmd === "export" && a1) { auth(); await cmdExport(a1, a2); }
  else { console.log("사용: node docs/gitbook-export.mjs list | export <spaceId> [출력폴더]"); process.exit(1); }
}
