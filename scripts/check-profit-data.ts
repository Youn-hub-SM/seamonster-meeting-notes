import fs from "fs"; import path from "path"; import ExcelJS from "exceljs";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
const num=(v:any)=>(v&&typeof v==="object"&&"result"in v?v.result:v);
async function main(){
  loadEnv();
  const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile("C:/Users/younh/Desktop/claude/파이썬/이익률계산기/이익률계산백데이터.xlsx");
  const s0=wb.worksheets[0]; const back=new Map<string,{cost:number;wt:number}>();
  s0.eachRow((r,i)=>{if(i>1){const vals=r.values as any[]; const code=String(num(vals[3])||"").trim(); const wt=Number(num(vals[4])); const cost=Number(num(vals[5])); if(code) back.set(code,{cost,wt});}});
  console.log(`백데이터 관리코드 ${back.size}개`);
  const {createClient}=await import("@supabase/supabase-js");
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  const {data:prods}=await sb.from("products").select("sku,cost_price,volume_kg").not("sku","is",null);
  const pm=new Map<string,{cost:number;wt:number|null}>();
  for(const p of prods||[]) pm.set(String(p.sku).trim(),{cost:Number(p.cost_price),wt:p.volume_kg==null?null:Number(p.volume_kg)});
  console.log(`products sku ${pm.size}개`);
  let matched=0,costOk=0,wtOk=0,missing=0,wtNull=0; const mism:string[]=[];
  for(const [code,b] of back){const p=pm.get(code); if(!p){missing++; continue;} matched++;
    if(Math.abs(p.cost-b.cost)<1) costOk++; else if(mism.length<12) mism.push(`  ${code}: 백데이터원가 ${b.cost} vs products ${p.cost}`);
    if(p.wt==null) wtNull++; else if(Math.abs(p.wt-b.wt)<0.001) wtOk++;
  }
  console.log(`\n백데이터 코드 중 products에 있음: ${matched}, 없음: ${missing}`);
  console.log(`  원가 일치: ${costOk}/${matched} · 중량 일치: ${wtOk}/${matched} · products 중량 null: ${wtNull}`);
  if(mism.length) console.log("원가 불일치 예시:\n"+mism.join("\n"));
}
main().catch(e=>{console.error(e);process.exit(1);});
