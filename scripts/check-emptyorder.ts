import fs from "fs"; import path from "path";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
async function main(){loadEnv();const {createClient}=await import("@supabase/supabase-js");const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  const {count:total}=await sb.from("sales_orders").select("*",{count:"exact",head:true});
  const {count:empty}=await sb.from("sales_orders").select("*",{count:"exact",head:true}).or("order_id.is.null,order_id.eq.");
  console.log(`sales_orders 총 ${total} · order_id 빈값/null ${empty} (${((empty!/total!)*100).toFixed(2)}%)`);
}
main().catch(e=>{console.error(e);process.exit(1);});
