// 배송일지.xlsx 'code' 탭 → 상품마스터(products) courier_name·courier_weight 시딩.
//  매칭 SKU 갱신, 없는 SKU 신규 생성. 054 미적용이면 courier 컬럼 오류로 중단.
import fs from "fs"; import path from "path";
import ExcelJS from "exceljs";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
function cs(c:ExcelJS.Cell):string{const v=c.value as unknown;if(v==null)return"";if(typeof v==="object"){const o=v as Record<string,unknown>;if("result"in o)return String(o.result??"");if("text"in o)return String(o.text??"");if(Array.isArray(o.richText))return (o.richText as {text:string}[]).map(t=>t.text).join("");}return String(v);}
async function main(){
  loadEnv();
  // code 탭 읽기
  const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile("C:\\Users\\younh\\Downloads\\배송일지.xlsx");
  const ws=wb.getWorksheet("code"); if(!ws){console.error("code 시트 없음");return;}
  const codes:{sku:string;courier_name:string;courier_weight:number}[]=[];
  for(let r=2;r<=ws.rowCount;r++){const sku=cs(ws.getRow(r).getCell(1)).trim();if(!sku)continue;codes.push({sku,courier_name:cs(ws.getRow(r).getCell(5)).trim(),courier_weight:Number(cs(ws.getRow(r).getCell(4)))||0});}
  console.log(`code 탭 ${codes.length}개 읽음`);

  const {createClient}=await import("@supabase/supabase-js");
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  const {data:prods,error}=await sb.from("products").select("id,sku");
  if(error){console.error("products 조회:",error.message);return;}
  const bySku=new Map<string,string[]>(); for(const p of prods||[]){const s=String(p.sku||"").trim().toUpperCase();if(s)bySku.set(s,[...(bySku.get(s)||[]),p.id]);}

  const updates:{id:string;courier_name:string;courier_weight:number}[]=[]; const inserts:Record<string,unknown>[]=[];
  let upd=0,cre=0;
  for(const c of codes){const ids=bySku.get(c.sku.toUpperCase());
    if(ids?.length){for(const id of ids)updates.push({id,courier_name:c.courier_name,courier_weight:c.courier_weight});upd++;}
    else{inserts.push({sku:c.sku,name:c.courier_name||c.sku,unit:"개",tax_type:"taxable",active:true,courier_name:c.courier_name,courier_weight:c.courier_weight});cre++;}}
  console.log(`갱신 대상 ${upd}(행 ${updates.length}) · 신규 ${cre}`);

  // 기존은 부분 update(id별) — 부분 upsert 는 name NOT NULL 위반이라 사용 불가
  let done=0;
  for(const u of updates){const {error:e}=await sb.from("products").update({courier_name:u.courier_name,courier_weight:u.courier_weight}).eq("id",u.id);if(e){console.error("갱신 오류(054 적용 확인):",e.message);return;}done++;if(done%50===0)console.log(`  갱신 ${done}/${updates.length}`);}
  if(inserts.length){const {error:e}=await sb.from("products").insert(inserts);if(e){console.error("신규 오류:",e.message);return;}}
  console.log(`✅ 완료 — 갱신 ${upd}개 · 신규 ${cre}개`);
  // 검증
  const {count}=await sb.from("products").select("*",{count:"exact",head:true}).neq("courier_name","");
  console.log(`상품마스터 courier_name 채워진 상품: ${count}개`);
}
main().catch(e=>{console.error(e);process.exit(1);});
