import fs from "fs"; import path from "path"; import ExcelJS from "exceljs";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
const num=(v:any)=>(v&&typeof v==="object"&&"result"in v?v.result:v);
async function main(){
  loadEnv();
  const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile("C:/Users/younh/Desktop/claude/파이썬/이익률계산기/이익률계산백데이터.xlsx");
  const s0=wb.worksheets[0]; const cost=new Map<string,{wt:number;cost:number}>();
  s0.eachRow((r,i)=>{if(i>1){const vals=r.values as any[]; const code=String(num(vals[2])||"").trim(); const wt=Number(num(vals[3])); const c=Number(num(vals[4])); if(code) cost.set(code,{wt,cost:c});}});
  console.log(`백데이터 코드 ${cost.size}개:`, [...cost.keys()].join(", "));
  const {createClient}=await import("@supabase/supabase-js");
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  const to=(await sb.rpc("sales_date_bounds")).data?.[0]?.max_date;
  const from=new Date(new Date(to).getTime()-90*864e5).toISOString().slice(0,10);
  console.log(`기간 ${from}~${to}`);
  let off=0,total=0,matched=0,lines=0,mlines=0; const missAmt=new Map<string,number>();
  for(;off<400000;off+=1000){
    const {data,error}=await sb.from("sales_orders").select("sku_code,subtotal_amount").gte("order_date",from).lte("order_date",to).range(off,off+999);
    if(error){console.error(error.message);break;} if(!data||!data.length)break;
    for(const r of data){const amt=Number(r.subtotal_amount)||0; total+=amt; lines++; const sc=String(r.sku_code||"").trim();
      if(cost.has(sc)){matched+=amt;mlines++;} else missAmt.set(sc,(missAmt.get(sc)||0)+amt);}
    if(data.length<1000)break;
  }
  console.log(`\n라인 ${lines} · 총결제금액 ${total.toLocaleString()}`);
  console.log(`매칭: 라인 ${mlines}(${(mlines/lines*100).toFixed(1)}%) · 금액 ${matched.toLocaleString()}(${(matched/total*100).toFixed(1)}%)`);
  const top=[...missAmt.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15);
  console.log("\n미매칭 상위 sku_code(금액):"); for(const [s,a] of top) console.log(`  ${s}: ${a.toLocaleString()}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
