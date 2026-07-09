// flow 기본 projectId 설정(1회성) — b2b_settings.flow_project_id 저장.
import fs from "fs";
import path from "path";
function loadEnv() {
  for (const f of [".env.local", ".env"]) {
    const p = path.resolve(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]]) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
async function main() {
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("env 없음"); process.exit(1); }
  const projectId = process.argv[2] || "2096412";
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { error } = await sb.from("b2b_settings").upsert({ key: "flow_project_id", value: { v: projectId }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) { console.error("실패:", error.message); process.exit(1); }
  console.log(`✅ flow_project_id = ${projectId} 저장 완료`);
}
main().catch((e) => { console.error(e); process.exit(1); });
