// Looker 연동 진단(1회성) — sales_looker 뷰 존재/조회 확인(서비스 키, REST 경유).
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
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error, count } = await sb.from("sales_looker").select("order_date,channel,subtotal_amount", { count: "exact" }).limit(2);
  if (error) { console.log(`❌ sales_looker 조회 실패: ${error.message}\n   → 041 미적용 가능성(뷰 없음). SQL Editor에서 041 실행 필요.`); return; }
  console.log(`✅ sales_looker OK · 총 ${count?.toLocaleString()}행 · 샘플 ${JSON.stringify(data)}`);
  console.log("   → 뷰·데이터는 정상. 남은 원인은 looker_ro 비밀번호 불일치 또는 SSL 인증서.");
}
main().catch((e) => { console.error(e); process.exit(1); });
