import fs from "fs"; import path from "path";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
async function main(){loadEnv();const {createClient}=await import("@supabase/supabase-js");const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  const to=(await sb.rpc("sales_date_bounds")).data?.[0]?.max_date; const from=new Date(new Date(to).getTime()-90*864e5).toISOString().slice(0,10);
  // 카페24 정기배송 포함 상품명 샘플
  const {data:sub}=await sb.from("sales_orders").select("product_name").eq("channel","카페24").ilike("product_name","%정기배송%").gte("order_date",from).limit(8);
  console.log("카페24 '정기배송' 포함 상품명 샘플:"); for(const r of sub||[]) console.log("  "+r.product_name);
  const {count:subc}=await sb.from("sales_orders").select("*",{count:"exact",head:true}).eq("channel","카페24").ilike("product_name","%정기배송%").gte("order_date",from);
  const {count:allc}=await sb.from("sales_orders").select("*",{count:"exact",head:true}).eq("channel","카페24").gte("order_date",from);
  console.log(`\n카페24 라인 ${allc} 중 정기배송 포함 ${subc}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
