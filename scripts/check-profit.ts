import fs from "fs"; import path from "path";
import { computeProfitRow, computeProfitTotals } from "../app/lib/sales-profit";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
const won=(n:number)=>Math.round(n).toLocaleString();
async function main(){
  loadEnv();
  const from=process.argv[2]||"2026-06-01", to=process.argv[3]||"2026-06-30";
  const {createClient}=await import("@supabase/supabase-js");
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  const {data:sum,error}=await sb.rpc("sales_profit_summary",{p_from:from,p_to:to});
  if(error){console.error(error.message);process.exit(1);}
  const rows=(sum as any[]).map(r=>computeProfitRow({channel:String(r.channel),orders:+r.orders,pay_amount:+r.pay_amount,ship_revenue:+r.ship_revenue||0,product_cost:+r.product_cost,cooling:+r.cooling,fee_rate:+r.fee_rate||0}));
  const t=computeProfitTotals(rows);
  console.log(`\n=== 채널별 매출·이익 ${from}~${to} ===`);
  console.log("판매처       주문   총매출        총상품원가     수수료       택배보냉비   매출총이익    이익률");
  for(const r of rows) console.log(`${r.channel.padEnd(10)} ${String(r.orders).padStart(5)} ${won(r.gross_revenue).padStart(12)} ${won(r.product_cost).padStart(12)} ${won(r.fee).padStart(10)} ${won(r.cooling).padStart(10)} ${won(r.profit).padStart(12)} ${r.margin_pct.toFixed(2).padStart(7)}%`);
  console.log(`${"합계".padEnd(10)} ${String(t.orders).padStart(5)} ${won(t.gross_revenue).padStart(12)} ${won(t.product_cost).padStart(12)} ${won(t.fee).padStart(10)} ${won(t.cooling).padStart(10)} ${won(t.profit).padStart(12)} ${t.margin_pct.toFixed(2).padStart(7)}%`);
  const {data:unm}=await sb.rpc("sales_profit_unmatched",{p_from:from,p_to:to});
  const ua=(unm as any[]).reduce((a,u)=>a+ +u.amount_sum,0);
  console.log(`\n미매칭 코드 ${(unm as any[]).length}개 · 금액 ${won(ua)}원`);
}
main().catch(e=>{console.error(e);process.exit(1);});
