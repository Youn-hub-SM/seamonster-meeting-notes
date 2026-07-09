import fs from "fs"; import path from "path";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
async function main(){loadEnv();const {createClient}=await import("@supabase/supabase-js");const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  const {data:cfg,error}=await sb.from("sales_channel_config").select("*").order("channel");
  if(error){console.log("config 조회 에러:",error.message);}else{console.log("== sales_channel_config ==");for(const c of cfg||[])console.log(`  ${c.channel}: mode=${c.ship_mode} fee=${c.fee_rate} ship=${c.ship_fee} free=${c.ship_free_over} sub=${c.ship_free_over_sub}`);}
  const {data:sum,err2}=await sb.rpc("sales_profit_summary",{p_from:"2026-06-01",p_to:"2026-06-30"}) as any;
  console.log("\n== 6월 RPC(배송비매출 확인) ==");
  for(const r of sum||[]) console.log(`  ${r.channel}: 주문 ${r.orders} · 배송비매출 ${Number(r.ship_revenue).toLocaleString()} (4000×주문=${(r.orders*4000).toLocaleString()}) · fee_rate ${r.fee_rate}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
