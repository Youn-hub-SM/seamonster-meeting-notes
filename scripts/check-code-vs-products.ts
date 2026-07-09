import fs from "fs"; import path from "path";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
async function main(){
  loadEnv();
  const {createClient}=await import("@supabase/supabase-js");
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  const code=JSON.parse(fs.readFileSync("C:\\Users\\younh\\AppData\\Local\\Temp\\claude\\C--Users-younh-Desktop-claude\\79704dc2-0617-44b3-8592-50308a510654\\scratchpad\\code-table.json","utf8")) as {sku:string;totalW:unknown;name:string}[];
  const codeSkus=new Set(code.map(c=>String(c.sku).trim().toUpperCase()));
  const {data:prods}=await sb.from("products").select("sku,name,active,volume_kg");
  const prodSkus=new Set((prods||[]).map(p=>String(p.sku||"").trim().toUpperCase()).filter(Boolean));
  const inBoth=[...codeSkus].filter(s=>prodSkus.has(s));
  const codeOnly=[...codeSkus].filter(s=>!prodSkus.has(s));
  const prodOnly=[...prodSkus].filter(s=>!codeSkus.has(s));
  console.log(`code 시트 SKU ${codeSkus.size}개 · products SKU ${prodSkus.size}개`);
  console.log(`  둘 다 있음: ${inBoth.length}`);
  console.log(`  code 에만(=상품마스터에 없음): ${codeOnly.length}`);
  console.log(`  products 에만(택배코드 없음): ${prodOnly.length}`);
  console.log(`\ncode 에만 있는(상품마스터에 없는) SKU 상위 25:`);
  for(const s of codeOnly.slice(0,25)) console.log(`  ${s}  | ${code.find(c=>String(c.sku).trim().toUpperCase()===s)?.name?.replace(/\s+/g," ").slice(0,40)}`);
  // 중량 비교(둘 다 있는 것 중, code 총중량 vs products.volume_kg)
  const pById=new Map((prods||[]).map(p=>[String(p.sku||"").trim().toUpperCase(),p]));
  let diffW=0; const ex:string[]=[];
  for(const s of inBoth){const c=code.find(x=>String(x.sku).trim().toUpperCase()===s);const p=pById.get(s);const cw=Number(c?.totalW)||0,pw=Number(p?.volume_kg)||0;if(Math.abs(cw-pw)>0.01){diffW++;if(ex.length<12)ex.push(`${s}: code총중량 ${cw} vs products부피 ${pw}`);}}
  console.log(`\n둘 다 있는 ${inBoth.length}개 중 code총중량 ≠ products.volume_kg: ${diffW}개`);
  for(const e of ex) console.log(`  ${e}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
