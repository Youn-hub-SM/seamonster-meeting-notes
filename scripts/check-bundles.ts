import fs from "fs"; import path from "path";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
async function main(){
  loadEnv();
  const {createClient}=await import("@supabase/supabase-js");
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  // products: id→{sku,cost,vol}
  const {data:prods}=await sb.from("products").select("id,sku,cost_price,volume_kg");
  const byId=new Map<string,any>(); for(const p of prods||[]) byId.set(p.id,{sku:String(p.sku||"").trim(),cost:Number(p.cost_price)||0,vol:p.volume_kg==null?null:Number(p.volume_kg)});
  const {data:bundles}=await sb.from("product_bundles").select("parent_id,component_id,qty");
  console.log(`product_bundles ${bundles?.length||0}행 · products ${byId.size}개`);
  // parent sku → resolved cost/vol (구성품 합)
  const parent=new Map<string,{cost:number;vol:number|null;comps:string[]}>();
  for(const b of bundles||[]){const par=byId.get(b.parent_id),co=byId.get(b.component_id);if(!par||!co)continue;
    const e=parent.get(par.sku)||{cost:0,vol:0 as number|null,comps:[]};
    e.cost+=co.cost*b.qty; e.vol=(e.vol==null||co.vol==null)?(co.vol==null?null:e.vol):(e.vol+co.vol*b.qty);
    if(co.vol==null) e.vol=null;
    e.comps.push(`${co.sku}×${b.qty}(원가${co.cost}·부피${co.vol})`); parent.set(par.sku,e);}
  console.log(`\n묶음 부모 ${parent.size}개 · 예시:`);
  for(const [sku,e] of [...parent].slice(0,8)) console.log(`  ${sku} → 원가 ${e.cost} 부피 ${e.vol} = ${e.comps.join(" + ")}`);
  // resolve fn: 판매 sku → cost/vol (묶음이면 구성품합, 아니면 자기값)
  const own=new Map<string,{cost:number;vol:number|null}>(); for(const p of prods||[]) own.set(String(p.sku||"").trim(),{cost:Number(p.cost_price)||0,vol:p.volume_kg==null?null:Number(p.volume_kg)});
  const resolve=(sku:string)=>{const b=parent.get(sku); if(b) return b; const o=own.get(sku); return o?{cost:o.cost,vol:o.vol}:null;};
  // 매출 90일 커버리지: cost>0 && vol!=null 인 금액 비율
  const to=(await sb.rpc("sales_date_bounds")).data?.[0]?.max_date; const from=new Date(new Date(to).getTime()-90*864e5).toISOString().slice(0,10);
  let off=0,total=0,ok=0; const miss=new Map<string,number>();
  for(;off<400000;off+=1000){const {data,error}=await sb.from("sales_orders").select("sku_code,subtotal_amount").gte("order_date",from).lte("order_date",to).range(off,off+999);if(error){console.error(error.message);break;}if(!data||!data.length)break;
    for(const r of data){const amt=Number(r.subtotal_amount)||0;total+=amt;const sc=String(r.sku_code||"").trim();const rz=resolve(sc);if(rz&&rz.cost>0&&rz.vol!=null)ok+=amt;else miss.set(sc,(miss.get(sc)||0)+amt);}if(data.length<1000)break;}
  console.log(`\n매출 90일 ${total.toLocaleString()} · 묶음전개 후 원가·중량 확보 금액: ${(ok/total*100).toFixed(1)}%`);
  console.log("여전히 미확보 상위:"); for(const [s,a] of [...miss].sort((x,y)=>y[1]-x[1]).slice(0,12)) console.log(`  ${s}: ${a.toLocaleString()} ${parent.has(s)?"(묶음이나 구성품 원가/부피 결측)":own.has(s)?"(단품 원가/부피 결측)":"(products 없음)"}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
