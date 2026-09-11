// Supabase 전체 데이터 수동 백업 (공식 권장 방식) — DB는 Supabase CLI `db dump`, Storage는 REST 다운로드.
//  한 번 실행하면 {BACKUP_DIR}/supabase-YYYYMMDD-HHmm/ 아래에:
//    db/schema.sql   ← 전체 스키마(테이블·뷰·함수·인덱스; sales_customers 표 구조 포함)
//    db/data.sql     ← 전체 데이터(개인정보 테이블 sales_customers 행은 제외 — 기본값)
//    storage/<버킷>/… ← 업로드된 실제 파일(company-docs 서류·voc-photos 사진)
//    manifest.json / README.txt
//  → 그 폴더가 OneDrive 동기화 폴더 안이면 자동으로 클라우드에 올라감. NAS·외장하드면 그 경로로.
//
//  실행:  scripts\backup-supabase.bat 더블클릭  (또는 node scripts/backup-supabase.mjs)
//  설정:  저장소 루트 backup.env (git 제외) — backup.env.example 복사해서 채우기.
//    DB_URL=postgresql://postgres.<ref>:<DB비밀번호>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres
//    SUPABASE_URL=https://<ref>.supabase.co
//    SUPABASE_SERVICE_KEY=sb_secret_...        (Storage 다운로드용)
//    BACKUP_DIR=C:/Users/younh/OneDrive - 주식회사 씨몬스터/Supabase백업
//    EXCLUDE_DATA=public.sales_customers        (선택 — 데이터에서 뺄 표. 기본=개인정보 표)
//    SCHEMAS=public,factory                     (선택 — 덤프할 스키마)
//  ※ DB는 Node가 `npx --yes supabase ...`로 CLI를 자동 내려받아 실행(전역 설치 불필요).

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadConfig() {
  const cfg = {};
  const p = path.join(ROOT, "backup.env");
  if (fs.existsSync(p)) {
    for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i <= 0) continue;
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      cfg[line.slice(0, i).trim()] = v;
    }
  }
  const g = (k, d = "") => (process.env[k] ?? cfg[k] ?? d);
  return {
    dbUrl: g("DB_URL"),
    url: g("SUPABASE_URL", "https://uwbkejkztuhzcesrffzq.supabase.co").replace(/\/+$/, ""),
    key: g("SUPABASE_SERVICE_KEY"),
    dir: g("BACKUP_DIR"),
    exclude: g("EXCLUDE_DATA", "public.sales_customers").split(",").map((s) => s.trim()).filter(Boolean),
    schemas: g("SCHEMAS", "public,factory"),
  };
}

const pad = (n) => String(n).padStart(2, "0");
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`; // cmd 인자 따옴표

// ── DB 덤프 (Supabase CLI) ──
function dumpDb(dbUrl, outDir, schemas, exclude) {
  const schemaFile = path.join(outDir, "schema.sql");
  const dataFile = path.join(outDir, "data.sql");
  const run = (label, extra) => {
    const cmd = `npx --yes supabase db dump --db-url ${q(dbUrl)} --schema ${q(schemas)} ${extra}`;
    console.log(`  [DB] ${label} ...`);
    const r = spawnSync(cmd, { stdio: "inherit", shell: true, cwd: ROOT });
    if (r.status !== 0) throw new Error(`supabase db dump(${label}) 실패 (exit ${r.status}). CLI/DB_URL/네트워크 확인.`);
  };
  run("스키마", `-f ${q(schemaFile)}`);
  const xs = exclude.map((t) => `-x ${q(t)}`).join(" ");
  run("데이터(개인정보 제외)", `--data-only --use-copy ${xs} -f ${q(dataFile)}`);
  return {
    schema_file: "db/schema.sql", schema_bytes: fs.statSync(schemaFile).size,
    data_file: "db/data.sql", data_bytes: fs.statSync(dataFile).size,
    excluded_data: exclude, schemas: schemas.split(","),
  };
}

// ── Storage 다운로드 (REST) ──
async function fetchJson(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 150)}`);
  return r.json();
}
async function dumpStorage(url, key, outDir) {
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const buckets = await fetchJson(`${url}/storage/v1/bucket`, { headers: h });
  const summary = [];
  for (const b of buckets) {
    const bucket = b.name || b.id;
    let files = 0, bytes = 0;
    // 폴더 재귀(list 는 folder=id null 로 옴). prefix 스택 + offset 페이징.
    const stack = [""];
    while (stack.length) {
      const prefix = stack.pop();
      let offset = 0;
      for (;;) {
        const page = await fetchJson(`${url}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
          method: "POST", headers: { ...h, "Content-Type": "application/json" },
          body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: "name", order: "asc" } }),
        });
        for (const it of page) {
          const full = prefix ? `${prefix}${it.name}` : it.name;
          if (!it.id && !it.metadata) { stack.push(`${full}/`); continue; } // 폴더
          const res = await fetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}/${full.split("/").map(encodeURIComponent).join("/")}`, { headers: h, signal: AbortSignal.timeout(120_000) });
          if (!res.ok) { console.error(`    ⚠️ ${bucket}/${full} 다운로드 실패 HTTP ${res.status}`); continue; }
          const buf = Buffer.from(await res.arrayBuffer());
          const dest = path.join(outDir, bucket, ...full.split("/"));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, buf);
          files++; bytes += buf.length;
        }
        if (page.length < 100) break;
        offset += 100;
      }
    }
    console.log(`  [Storage] ${bucket}: 파일 ${files}개 (${(bytes / 1e6).toFixed(1)}MB)`);
    summary.push({ bucket, files, bytes });
  }
  return summary;
}

async function main() {
  const c = loadConfig();
  if (!c.dir) { console.error("[중단] backup.env 에 BACKUP_DIR(저장 폴더)을 넣으세요."); process.exit(1); }
  if (!c.dbUrl) { console.error("[중단] backup.env 에 DB_URL(대시보드 Connect 의 접속문자열, 비밀번호 포함)을 넣으세요."); process.exit(1); }
  if (!c.key) { console.error("[중단] backup.env 에 SUPABASE_SERVICE_KEY(Storage 다운로드용 secret 키)를 넣으세요."); process.exit(1); }

  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const base = path.join(c.dir, `supabase-${stamp}`);
  const dbDir = path.join(base, "db");
  const stDir = path.join(base, "storage");
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(stDir, { recursive: true });
  console.log(`백업 폴더: ${base}\n`);

  const manifest = { generated_at: now.toISOString(), source: c.url };
  let dbErr = null, stErr = null;

  console.log("1) DB 덤프 (Supabase CLI — 처음엔 CLI 자동 다운로드로 잠시 걸립니다)");
  try { manifest.db = dumpDb(c.dbUrl, dbDir, c.schemas, c.exclude); }
  catch (e) { dbErr = e.message; manifest.db = { error: dbErr }; console.error(`  [DB] ${dbErr}`); }

  console.log("\n2) Storage 파일 다운로드");
  try { manifest.storage = await dumpStorage(c.url, c.key, stDir); }
  catch (e) { stErr = e.message; manifest.storage = { error: stErr }; console.error(`  [Storage] ${stErr}`); }

  fs.writeFileSync(path.join(base, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(base, "README.txt"),
    "씨몬스터 Supabase 백업\n" +
    `생성: ${now.toISOString()}\n\n` +
    "[구성]\n db/schema.sql  — 전체 스키마(표·뷰·함수)\n db/data.sql    — 전체 데이터(개인정보 표 " + c.exclude.join(",") + " 행 제외)\n storage/…      — 업로드 파일(서류·사진)\n\n" +
    "[복원 요령]\n 1) 새(또는 초기화한) Supabase 프로젝트에 psql 로: psql \"<접속문자열>\" -f db/schema.sql  그다음  -f db/data.sql\n 2) Storage: 각 버킷을 만들고 storage/<버킷>/ 안의 파일을 같은 경로로 업로드\n ※ sales_customers(고객 전화·이름)는 백업에 없음 — 재구매 분석용 customer_key 는 sales_orders 에 있어 분석은 가능\n",
    "utf8");

  console.log(`\n완료. 폴더: ${base}`);
  if (dbErr || stErr) { console.error(`※ 일부 실패 — DB:${dbErr ? "실패" : "성공"} / Storage:${stErr ? "실패" : "성공"} (manifest 확인)`); process.exit(1); }
}

main().catch((e) => { console.error(`[중단] ${e?.message || e}`); process.exit(1); });
