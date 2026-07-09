// migration 051 inventory_reconcile 의 로직을 JS로 재현해 결과가 타당한지 사전 검증(기본창=최근30일).
import fs from "fs"; import path from "path";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
async function main(){
  loadEnv();
  const {createClient}=await import("@supabase/supabase-js");
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  const bounds=(await sb.rpc("sales_date_bounds")).data?.[0]; const to=String(bounds.max_date);
  const from=new Date(new Date(to).getTime()-30*864e5).toISOString().slice(0,10);
  console.log(`창: ${from} ~ ${to}`);

  const {data:prods}=await sb.from("products").select("id,sku,name,updated_at");
  // distinct on sku (최신)
  const bySku=new Map<string,{id:string;sku:string;name:string}>();
  for(const p of (prods||[]).slice().sort((a,b)=>String(a.updated_at).localeCompare(String(b.updated_at)))){const s=String(p.sku||"").trim();if(s)bySku.set(s,{id:p.id,sku:s,name:p.name});}
  const prodById=new Map((prods||[]).map(p=>[p.id,{sku:String(p.sku||"").trim(),name:p.name}]));

  // stock + flow
  const {data:txns}=await sb.from("inventory_txns").select("product_id,type,qty,txn_date,channel");
  const stock=new Map<string,number>(), lin=new Map<string,number>(), lout=new Map<string,number>(), ladj=new Map<string,number>();
  for(const t of txns||[]){const q=Number(t.qty)||0; stock.set(t.product_id,(stock.get(t.product_id)||0)+q);
    if(t.txn_date>=from&&t.txn_date<=to){ if(t.type==="입고")lin.set(t.product_id,(lin.get(t.product_id)||0)+q); else if(t.type==="출고")lout.set(t.product_id,(lout.get(t.product_id)||0)-q); else ladj.set(t.product_id,(ladj.get(t.product_id)||0)+q);}}

  // bundle map: parent sku -> [{comp sku, mult}]
  const {data:bundles}=await sb.from("product_bundles").select("parent_id,component_id,qty");
  const parentSkuOf=(id:string)=>prodById.get(id)?.sku||"";
  const bmap=new Map<string,{comp:string;mult:number}[]>();
  for(const b of bundles||[]){const ps=parentSkuOf(b.parent_id),cs=parentSkuOf(b.component_id);if(!ps||!cs)continue;bmap.set(ps,[...(bmap.get(ps)||[]),{comp:cs,mult:Number(b.qty)||1}]);}

  // sold_raw
  const soldRaw=new Map<string,number>();
  for(let off=0;off<400000;off+=1000){const {data}=await sb.from("sales_orders").select("sku_code,quantity").gte("order_date",from).lte("order_date",to).range(off,off+999);if(!data||!data.length)break;for(const r of data){const s=String(r.sku_code||"").trim();if(!s)continue;soldRaw.set(s,(soldRaw.get(s)||0)+(Number(r.quantity)||0));}if(data.length<1000)break;}
  // expand -> sold per product id
  const soldByProd=new Map<string,number>();
  const addSold=(sku:string,q:number)=>{const p=bySku.get(sku);if(p)soldByProd.set(p.id,(soldByProd.get(p.id)||0)+q);};
  for(const [sku,q] of soldRaw){const comps=bmap.get(sku);if(comps){for(const c of comps)addSold(c.comp,q*c.mult);}else addSold(sku,q);}

  // rows
  const ids=new Set<string>([...stock.keys(),...lin.keys(),...lout.keys(),...ladj.keys(),...soldByProd.keys()]);
  const rows=[...ids].map(id=>({name:prodById.get(id)?.name||"?",sku:prodById.get(id)?.sku||"",cur:stock.get(id)||0,lin:lin.get(id)||0,lout:lout.get(id)||0,ladj:ladj.get(id)||0,sold:soldByProd.get(id)||0}))
    .filter(r=>r.cur||r.lin||r.lout||r.ladj||r.sold);
  const sold=rows.reduce((s,r)=>s+r.sold,0), out=rows.reduce((s,r)=>s+r.lout,0), adj=rows.reduce((s,r)=>s+r.ladj,0);
  const noPur=rows.filter(r=>r.sold>0&&r.lin===0), neg=rows.filter(r=>r.cur<0);
  console.log(`\n대사 대상 ${rows.length}행`);
  console.log(`실판매 ${sold.toLocaleString()} · 원장출고 ${out.toLocaleString()} · 반영률 ${sold?((out/sold*100).toFixed(1)):0}%`);
  console.log(`매입 미기록 SKU ${noPur.length}건(판매 ${noPur.reduce((s,r)=>s+r.sold,0).toLocaleString()}) · 현재고 음수 ${neg.length}건 · 조정합 ${adj.toLocaleString()}`);
  console.log(`\n판매 상위 8:`);
  for(const r of rows.slice().sort((a,b)=>b.sold-a.sold).slice(0,8)) console.log(`  ${r.name} [${r.sku}] 현재고 ${r.cur} 실판매 ${r.sold} 입고 ${r.lin} 출고 ${r.lout} 조정 ${r.ladj}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
