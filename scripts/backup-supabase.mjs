// Supabase 전체 데이터 수동 백업 → 지정 폴더(OneDrive 동기화 폴더)에 테이블별 파일로 저장.
//  Supabase Pro 자동 백업(7일) 위에 얹는 '오프라인 사본'. REST(PostgREST) + 서비스 키로 전 테이블을 떠서
//  {BACKUP_DIR}/supabase-YYYYMMDD-HHmm/{테이블}.ndjson.gz + manifest.json 로 남긴다.
//  복원: 각 파일은 한 줄=한 행(JSON)인 NDJSON(gzip). Supabase 로 되돌릴 땐 같은 테이블에 upsert.
//
//  실행:  node scripts/backup-supabase.mjs   (또는 scripts/backup-supabase.bat 더블클릭)
//  설정:  저장소 루트의 backup.env (git 제외됨) 에 아래를 채운다 —
//    SUPABASE_URL=https://uwbkejkztuhzcesrffzq.supabase.co
//    SUPABASE_SERVICE_KEY=sb_secret_...        (대시보드 Settings > API > service_role/secret 키)
//    BACKUP_DIR=C:/Users/younh/OneDrive - 주식회사 씨몬스터/Supabase백업
//    SKIP_TABLES=sales_customers               (선택 — 개인정보 등 빼고 싶은 테이블, 콤마로 여러 개)
//  ※ 시크릿 키는 여기(코드)·채팅에 넣지 말고 backup.env 에만.

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── 설정 로드 (backup.env + 환경변수) ──
function loadConfig() {
  const cfg = {};
  const envPath = path.join(ROOT, "backup.env");
  if (fs.existsSync(envPath)) {
    for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      cfg[k] = v;
    }
  }
  const get = (k, d = "") => (process.env[k] ?? cfg[k] ?? d);
  return {
    url: get("SUPABASE_URL", "https://uwbkejkztuhzcesrffzq.supabase.co").replace(/\/+$/, ""),
    key: get("SUPABASE_SERVICE_KEY"),
    dir: get("BACKUP_DIR"),
    skip: new Set(get("SKIP_TABLES").split(",").map((s) => s.trim()).filter(Boolean)),
  };
}

// 파생 뷰(원본 테이블의 재가공) — 백업에서 제외(중복·용량). 나머지는 전부 뜬다.
const DERIVED_VIEWS = new Set([
  "sales_looker", "sales_okr", "sales_customer_summary",
  "sales_daily_new_repeat", "sales_group_repeat", "sales_buyer_repeat",
]);

const PAGE = 1000;
const pad = (n) => String(n).padStart(2, "0");

async function main() {
  const { url, key, dir, skip } = loadConfig();
  if (!key) {
    console.error("[중단] backup.env 에 SUPABASE_SERVICE_KEY(대시보드 Settings > API 의 service_role/secret 키)를 넣으세요.");
    process.exit(1);
  }
  if (!dir) {
    console.error("[중단] backup.env 에 BACKUP_DIR(백업을 저장할 OneDrive 폴더 경로)을 넣으세요.");
    process.exit(1);
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  // 1) 노출된 테이블·뷰 목록 (PostgREST OpenAPI)
  const specRes = await fetch(`${url}/rest/v1/`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!specRes.ok) {
    const body = await specRes.text().catch(() => "");
    console.error(`[중단] 목록 조회 실패 (HTTP ${specRes.status}) ${body.slice(0, 200)}`);
    console.error("       키가 새 sb_secret_ 키인지, URL 이 맞는지 확인하세요(옛 legacy 키는 비활성).");
    process.exit(1);
  }
  const spec = await specRes.json();
  const all = Object.keys(spec.definitions || {}).sort();
  const targets = all.filter((t) => !DERIVED_VIEWS.has(t) && !skip.has(t));
  if (targets.length === 0) {
    console.error("[중단] 백업할 테이블이 없습니다(목록 파싱 실패 가능).");
    process.exit(1);
  }

  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const outDir = path.join(dir, `supabase-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`백업 폴더: ${outDir}`);
  console.log(`대상 테이블 ${targets.length}개 (뷰 ${all.length - targets.length}개 제외)`);

  const manifest = { generated_at: now.toISOString(), source: url, tables: [], skipped: [...skip], views_excluded: all.filter((t) => DERIVED_VIEWS.has(t)) };
  let grandRows = 0, failed = 0;

  for (const table of targets) {
    const file = path.join(outDir, `${table}.ndjson.gz`);
    const gzip = zlib.createGzip();
    const out = fs.createWriteStream(file);
    gzip.pipe(out);
    const write = (s) => new Promise((res) => { if (gzip.write(s)) res(); else gzip.once("drain", res); });

    let from = 0, rows = 0, total = null, err = null;
    try {
      for (;;) {
        const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?select=*`, {
          headers: { ...headers, "Range-Unit": "items", Range: `${from}-${from + PAGE - 1}`, Prefer: "count=exact" },
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) { err = `HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`.trim(); break; }
        const cr = res.headers.get("content-range");
        if (cr && cr.includes("/")) { const t = cr.split("/")[1]; if (t && t !== "*") total = Number(t); }
        const batch = await res.json();
        for (const r of batch) await write(JSON.stringify(r) + "\n");
        rows += batch.length;
        if (batch.length < PAGE) break;
        from += PAGE;
      }
    } catch (e) { err = e?.message || String(e); }

    await new Promise((res) => { gzip.end(() => out.on("finish", res)); });
    const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (err) { failed++; fs.rmSync(file, { force: true }); }
    manifest.tables.push({ name: table, rows, expected: total, bytes: err ? 0 : bytes, error: err || undefined });
    grandRows += rows;
    const warn = total != null && total !== rows ? `  ⚠️기대 ${total}` : "";
    console.log(`${err ? "실패" : "완료"}  ${table}: ${rows.toLocaleString()}행${warn}${err ? `  (${err})` : ""}`);
  }

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\n총 ${targets.length}개 테이블 · ${grandRows.toLocaleString()}행 백업${failed ? ` · 실패 ${failed}개(위 로그·manifest 확인)` : ""}`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(`[중단] ${e?.message || e}`); process.exit(1); });
