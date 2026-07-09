import fs from "fs"; import path from "path";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
async function main(){
  loadEnv();
  const {createClient}=await import("@supabase/supabase-js");
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  // shipments 상태 분포 + 기간
  const {data:sh,error}=await sb.from("shipments").select("id,status,ship_date");
  if(error){console.error("shipments:",error.message);return;}
  const byS=new Map<string,number>(); for(const s of sh||[]) byS.set(s.status,(byS.get(s.status)||0)+1);
  const dates=(sh||[]).map(s=>s.ship_date).filter(Boolean).sort();
  console.log(`shipments ${sh?.length||0}행 · 상태:`, [...byS].map(([k,v])=>`${k} ${v}`).join(" · "));
  console.log(`ship_date 범위: ${dates[0]||"-"} ~ ${dates[dates.length-1]||"-"}`);
  // 발송완료 shipment_items → order_items.product_id 합
  const doneIds=new Set((sh||[]).filter(s=>s.status==="발송완료").map(s=>s.id));
  const {data:si,error:e2}=await sb.from("shipment_items").select("shipment_id,order_item_id,qty");
  if(e2){console.error("shipment_items:",e2.message);return;}
  const {data:oi,error:e3}=await sb.from("order_items").select("id,product_id,product_name");
  if(e3){console.error("order_items:",e3.message);return;}
  const oiById=new Map((oi||[]).map(o=>[o.id,o]));
  const soldByPid=new Map<string,{q:number;name:string}>();
  let orphan=0;
  for(const it of si||[]){if(!doneIds.has(it.shipment_id))continue;const o=oiById.get(it.order_item_id);if(!o||!o.product_id){orphan+=Number(it.qty)||0;continue;}const cur=soldByPid.get(o.product_id)||{q:0,name:o.product_name||"?"};cur.q+=Number(it.qty)||0;soldByPid.set(o.product_id,cur);}
  const total=[...soldByPid.values()].reduce((a,b)=>a+b.q,0);
  console.log(`\n발송완료 도매 판매(전체 기간) — 품목 ${soldByPid.size}개 · 총 ${total.toLocaleString()} (product_id 없음 ${orphan})`);
  for(const [,v] of [...soldByPid.entries()].sort((a,b)=>b[1].q-a[1].q).slice(0,8)) console.log(`  ${v.name}: ${v.q.toLocaleString()}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
