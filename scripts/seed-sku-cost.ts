// sales_sku_cost 시드(043 후 1회) — 백데이터 원가/중량 시트 업서트.
import fs from "fs"; import path from "path"; import ExcelJS from "exceljs";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
const cnum=(v:any)=>{if(v&&typeof v==="object"&&"result"in v)v=v.result;const n=Number(v);return Number.isFinite(n)?n:0;};
const cstr=(v:any)=>{if(v&&typeof v==="object"&&"result"in v)v=v.result;if(v&&typeof v==="object"&&"text"in v)v=v.text;return String(v??"").trim();};
const headerOf=(w:ExcelJS.Worksheet)=>{const raw=w.getRow(1).values as any[];return Array.from({length:raw.length},(_,i)=>cstr(raw[i]));};
async function main(){
  loadEnv();
  const file=process.argv[2]||"C:/Users/younh/Desktop/claude/파이썬/이익률계산기/이익률계산백데이터.xlsx";
  const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
  let ws=wb.worksheets[0];
  for(const w of wb.worksheets){if(headerOf(w).some(h=>h.includes("관리코드"))){ws=w;break;}}
  const header=headerOf(ws);
  const find=(...n:string[])=>header.findIndex(h=>n.some(x=>h.replace(/\s/g,"").includes(x)));
  const cCode=find("관리코드"),cW=find("중량"),cC=find("상품원가_단가","상품원가","원가","단가"),cN=find("상품명","상품");
  console.log(`시트 '${ws.name}' 헤더:`, header.filter(Boolean).join(", "), `| code=${cCode} wt=${cW} cost=${cC} name=${cN}`);
  if(cCode<0||cW<0||cC<0){console.error("컬럼 인식 실패");process.exit(1);}
  const now=new Date().toISOString(); const rows:any[]=[]; const seen=new Set<string>();
  ws.eachRow((row,i)=>{if(i===1)return;const v=row.values as any[];const code=cstr(v[cCode]);if(!code||seen.has(code))return;seen.add(code);
    rows.push({sku_code:code,product_name:cN>=0?(cstr(v[cN])||null):null,weight_kg:cnum(v[cW]),cost_price:Math.round(cnum(v[cC])),updated_at:now});});
  console.log(`파싱 ${rows.length}개 · 예시 ${JSON.stringify(rows[0])}`);
  const {createClient}=await import("@supabase/supabase-js");
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  for(let i=0;i<rows.length;i+=500){const {error}=await sb.from("sales_sku_cost").upsert(rows.slice(i,i+500),{onConflict:"sku_code"});if(error){console.error("실패:",error.message);process.exit(1);}}
  const {count}=await sb.from("sales_sku_cost").select("sku_code",{count:"exact",head:true});
  console.log(`✅ sales_sku_cost 업서트 완료 · 총 ${count}개`);
}
main().catch(e=>{console.error(e);process.exit(1);});
