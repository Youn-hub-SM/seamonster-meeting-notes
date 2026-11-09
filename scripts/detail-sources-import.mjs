// 상세페이지 전송 — 소스·조합 가져오기(1회성). docs/detail-sources/manifest.json 의 소스 파일과 조합을 API 로 등록한다.
//  실행(로컬): node scripts/detail-sources-import.mjs [서버URL] [--dry]
//   서버URL 기본 = 베타(dev). 운영에 넣으려면 https://meeting-notes-beryl.vercel.app
//  인증: .env.local 의 NAVER_COMMERCE_CLIENT_SECRET(업로드 공용 시크릿) Bearer — sources·sets POST 가 받아준다(가져오기 생성자).
//  같은 이름의 소스/조합이 이미 있으면 그 id 로 갱신(이름 기준 멱등). 쏘기는 하지 않는다 — 화면에서 사람이 누른다.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const SERVER = (args.find((a) => !a.startsWith("--")) || "https://meeting-notes-git-dev-younhyunshuk-5999s-projects.vercel.app").replace(/\/+$/, "");
const DIR = path.join(ROOT, "docs", "detail-sources");

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const secret = (env.NAVER_COMMERCE_CLIENT_SECRET || "").trim();
if (!secret) { console.error("[중단] NAVER_COMMERCE_CLIENT_SECRET 없음"); process.exit(1); }
const H = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };

async function api(method, p, body) {
  const res = await fetch(`${SERVER}${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(`${method} ${p} (HTTP ${res.status}) ${json.error || ""}`.trim());
  return json;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
  // GET 은 로그인 전용이라 목록을 못 읽는다 → 이름 기준 갱신은 응답으로 돌아온 id 를 manifest 에 저장해 둔 것으로 한다
  const idFile = path.join(DIR, "registered.json");
  const reg = fs.existsSync(idFile) ? JSON.parse(fs.readFileSync(idFile, "utf8")) : { sources: {}, sets: {} };

  const sourceId = {};
  for (const s of manifest.sources) {
    const html = fs.readFileSync(path.join(DIR, s.file), "utf8").replace(/^<!--[^]*?-->\s*/, ""); // 파일 머리 주석은 빼고 등록
    const body = { id: reg.sources[s.name] || undefined, name: s.name, html, position: s.position };
    if (DRY) { console.log(`[dry] 소스 ${s.name} (${html.length}자, ${s.position})${body.id ? ` → 갱신 #${body.id}` : " → 새로"}`); continue; }
    const j = await api("POST", "/api/detail/sources", body);
    sourceId[s.name] = j.source.id; reg.sources[s.name] = j.source.id;
    console.log(`소스 ${s.name} → #${j.source.id} v${j.source.version}`);
  }
  for (const t of manifest.sets) {
    const members = t.members.map((n) => sourceId[n] || reg.sources[n]).filter(Boolean);
    if (members.length !== t.members.length) { console.error(`  조합 ${t.name}: 구성 소스 id 를 못 찾음 — 소스 먼저 등록`); continue; }
    const body = { id: reg.sets[t.name] || undefined, name: t.name, members, position: t.position };
    if (DRY) { console.log(`[dry] 조합 ${t.name} [${t.members.join(" › ")}]${body.id ? ` → 갱신 #${body.id}` : " → 새로"}`); continue; }
    const j = await api("POST", "/api/detail/sets", body);
    reg.sets[t.name] = j.set.id;
    console.log(`조합 ${t.name} → #${j.set.id}`);
  }
  if (!DRY) fs.writeFileSync(idFile, JSON.stringify(reg, null, 2));
  console.log(DRY ? "dry-run 끝" : `등록 완료 — id 는 ${path.relative(ROOT, idFile)} 에 저장`);
}
main().catch((e) => { console.error(`[중단] ${e.message}`); process.exit(1); });
