// 리포트 숫자 검증(1회성) — computeDailyStats/computeWeeklyStats 실제 데이터 대조.
//  실행: npx tsx scripts/validate-report.ts [기준일 yyyy-mm-dd]
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

const won = (v: number) => `${Math.round(v || 0).toLocaleString()}원`;

async function main() {
  loadEnv();
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SALES_PII_PEPPER) {
    console.error("env 없음: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SALES_PII_PEPPER"); process.exit(1);
  }
  const { computeDailyStats, computeWeeklyStats, maxOrderDate } = await import("../app/lib/sales-report");
  const { buildDailyHtml, buildWeeklyHtml } = await import("../app/lib/sales-report-html");

  const base = process.argv[2] || (await maxOrderDate()) || "";
  console.log(`\n=== 기준일: ${base} ===`);
  const s = await computeDailyStats(base);
  console.log(`[일일] 기준일 ${s.date_str} (일요일=${s.is_sunday}, window ${s.window_start}~${s.window_end})`);
  console.log(`  창 매출(어제/금~일): ${won(s.window_sales)} | 주문 ${s.order_count}건 | 객단가 ${won(s.aov)}`);
  console.log(`  이번달 누적: ${won(s.this_month_sales)} (전월 ${won(s.prev_month_sales)}) 환산%=${s.month_rr_pct?.toFixed(1)}`);
  console.log(`  올해 누적:  ${won(s.this_year_sales)} (전년 ${won(s.last_year_sales)}) 페이스%=${s.year_rr_pct?.toFixed(1)}`);
  console.log(`  신규:재구매 = ${s.new_cust}:${s.repeat_cust} | 최고건 ${won(s.max_order)} 최저건 ${won(s.min_order)}`);
  console.log(`  채널(월누적): ${s.channels.map((c) => `${c} ${won(s.channel_summary[c].month)}`).join(", ")}`);
  console.log(`  Top5: ${s.top10.slice(0, 5).map((t) => `${t.rank}.${t.code} ${won(t.revenue)}`).join(" / ")}`);
  const html = buildDailyHtml(s);
  console.log(`  HTML 길이: ${html.length} chars (미리보기 정상 여부 = 태그 균형 확인용)`);

  // 주간(기준일이 속한 주)
  const w = await computeWeeklyStats(base);
  console.log(`[주간] ${w.week_start}~${w.week_end}: ${won(w.week_sales)} (전주 ${won(w.prev_week_sales)}) | 주문 ${w.order_count}건 | 신규:재구매 ${w.new_cust}:${w.repeat_cust}`);
  console.log(`  주간 HTML 길이: ${buildWeeklyHtml(w).length} chars`);
  console.log("\n검증 완료.");
}

main().catch((e) => { console.error("실패:", e); process.exit(1); });
