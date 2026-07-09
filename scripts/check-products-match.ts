import fs from "fs"; import path from "path"; import ExcelJS from "exceljs";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
const num=(v:any)=>(v&&typeof v==="object"&&"result"in v?v.result:v);
async function main(){
  loadEnv();
  const {createClient}=await import("@supabase/supabase-js");
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  const {data:one}=await sb.from("products").select("*").limit(1);
  console.log("products 컬럼:", Object.keys(one?.[0]||{}).join(", "));
  const {data:prods}=await sb.from("products").select("sku,cost_price,cost_material,volume_kg").not("sku","is",null);
  const pm=new Map<string,any>(); for(const p of prods||[]) pm.set(String(p.sku).trim(),p);
  console.log(`products sku ${pm.size}개 · 예시:`, JSON.stringify((prods||[]).slice(0,3)));
  // 백데이터 126코드
  const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile("C:/Users/younh/Desktop/claude/파이썬/이익률계산기/이익률계산백데이터.xlsx");
  const s0=wb.worksheets[0]; const back=new Map<string,{wt:number;cost:number}>();
  s0.eachRow((r,i)=>{if(i>1){const v=r.values as any[];const c=String(num(v[2])||"").trim();if(c)back.set(c,{wt:Number(num(v[3])),cost:Number(num(v[4]))});}});
  // 매출 90일 커버리지 (products.sku 기준)
  const to=(await sb.rpc("sales_date_bounds")).data?.[0]?.max_date;
  const from=new Date(new Date(to).getTime()-90*864e5).toISOString().slice(0,10);
  let off=0,total=0,mp=0,mb=0;
  for(;off<400000;off+=1000){const {data,error}=await sb.from("sales_orders").select("sku_code,subtotal_amount").gte("order_date",from).lte("order_date",to).range(off,off+999);if(error){console.error(error.message);break;}if(!data||!data.length)break;
    for(const r of data){const amt=Number(r.subtotal_amount)||0;total+=amt;const sc=String(r.sku_code||"").trim();if(pm.has(sc))mp+=amt;if(back.has(sc))mb+=amt;}if(data.length<1000)break;}
  console.log(`\n매출 90일(${from}~${to}) 총 ${total.toLocaleString()}`);
  console.log(`  products.sku 매칭 금액: ${(mp/total*100).toFixed(1)}% · 백데이터 매칭: ${(mb/total*100).toFixed(1)}%`);
  // 겹치는 코드 원가/중량 비교
  let ov=0,costEq=0,wtEq=0; const diffs:string[]=[];
  for(const [c,b] of back){const p=pm.get(c);if(!p)continue;ov++;const pc=Number(p.cost_price);const pm2=Number(p.cost_material);
    if(Math.abs(pc-b.cost)<1)costEq++;else if(diffs.length<10)diffs.push(`  ${c}: 백=${b.cost} | products.cost_price=${pc} cost_material=${p.cost_material} volume_kg=${p.volume_kg}(백중량 ${b.wt})`);}
  console.log(`\n백데이터∩products 코드 ${ov}개 · cost_price==백원가 ${costEq}개`);
  if(diffs.length)console.log("불일치 예시:\n"+diffs.join("\n"));
}
main().catch(e=>{console.error(e);process.exit(1);});
