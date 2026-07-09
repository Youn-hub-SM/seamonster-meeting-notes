import fs from "fs"; import path from "path";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
async function main(){
  loadEnv();
  const {createClient}=await import("@supabase/supabase-js");
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  const {data,error}=await sb.from("products").select("id,name,sku,cost_price,volume_kg,active").order("name");
  if(error){console.error(error.message);return;}
  const all=data||[];
  const byId=new Map<string,{cost:number;vol:number|null}>();
  for(const p of all) byId.set(p.id,{cost:Number(p.cost_price)||0,vol:p.volume_kg==null?null:Number(p.volume_kg)});
  const {data:bundles}=await sb.from("product_bundles").select("parent_id,component_id,qty");
  const bmap=new Map<string,{component_id:string;qty:number}[]>();
  for(const b of bundles||[]) bmap.set(b.parent_id,[...(bmap.get(b.parent_id)||[]),{component_id:b.component_id,qty:Number(b.qty)||1}]);
  const resolve=(id:string)=>{const comps=bmap.get(id);if(!comps)return null;let cost=0,vol:number|null=0,miss=false;for(const c of comps){const co=byId.get(c.component_id);if(!co){miss=true;continue;}cost+=co.cost*c.qty;if(co.vol==null)miss=true;else if(vol!=null)vol+=co.vol*c.qty;}return{cost,vol:miss?null:vol};};
  const active=all.filter(p=>p.active);
  // 현재(raw) vs 묶음전개(resolved) 커버리지
  const rawOk=active.filter(p=>Number(p.cost_price)>0).length;
  let resOk=0; const stillZero:string[]=[];
  for(const p of active){const r=resolve(p.id);const cost=r?r.cost:Number(p.cost_price)||0;if(cost>0)resOk++;else stillZero.push(`${p.name} [${p.sku||"-"}]${bmap.has(p.id)?" (묶음이나 구성품원가0)":" (단품·묶음아님)"}`);}
  console.log(`active ${active.length}개 · 묶음부모 ${[...bmap.keys()].filter(id=>byId.has(id)).length}개`);
  console.log(`cost>0 커버리지:  raw ${rawOk}(${(rawOk/active.length*100).toFixed(0)}%)  →  묶음전개 ${resOk}(${(resOk/active.length*100).toFixed(0)}%)`);
  console.log(`\n전개 후에도 cost=0 인 ${stillZero.length}개 상위:`);
  for(const s of stillZero.slice(0,15)) console.log(`  ${s}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
