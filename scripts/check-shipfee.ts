import fs from "fs"; import path from "path";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
async function main(){loadEnv();const {createClient}=await import("@supabase/supabase-js");const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  const to=(await sb.rpc("sales_date_bounds")).data?.[0]?.max_date; const from=new Date(new Date(to).getTime()-14*864e5).toISOString().slice(0,10);
  console.log(`기간 ${from}~${to}`);
  // 라인 pull (채널·주문·배송비·라인수 분석)
  const byOrder=new Map<string,{ch:string;fees:number[];}>();
  let off=0; for(;off<200000;off+=1000){const {data,error}=await sb.from("sales_orders").select("channel,order_id,shipping_fee").gte("order_date",from).lte("order_date",to).range(off,off+999);if(error){console.error(error.message);break;}if(!data||!data.length)break;
    for(const r of data){const k=r.order_id||"("+Math.random()+")";const e=byOrder.get(k)||{ch:r.channel,fees:[]};e.fees.push(Number(r.shipping_fee)||0);byOrder.set(k,e);}if(data.length<1000)break;}
  // 채널별: 주문수, 배송비합(주문 대표값=한줄에만 있으면 sum=max), 패턴
  const ch=new Map<string,{orders:number;sumAll:number;sumMax:number;repeated:number;oneLine:number;zero:number}>();
  for(const [,e] of byOrder){const c=e.ch||"?";const s=ch.get(c)||{orders:0,sumAll:0,sumMax:0,repeated:0,oneLine:0,zero:0};
    const nz=e.fees.filter(f=>f>0);const sum=e.fees.reduce((a,b)=>a+b,0);const mx=Math.max(0,...e.fees);
    s.orders++;s.sumAll+=sum;s.sumMax+=mx;
    if(nz.length===0)s.zero++; else if(nz.length===1)s.oneLine++; else if(nz.length===e.fees.length&&new Set(nz).size===1)s.repeated++;
    ch.set(c,s);}
  console.log("\n채널        주문수  배송비(모든줄합)  배송비(주문최대합)  1줄만  전줄반복  0원  다줄");
  for(const [c,s] of [...ch].sort((a,b)=>b[1].orders-a[1].orders)){
    const multi=s.orders-s.oneLine-s.repeated-s.zero;
    console.log(`${c.padEnd(10)} ${String(s.orders).padStart(6)} ${s.sumAll.toLocaleString().padStart(16)} ${s.sumMax.toLocaleString().padStart(16)}  ${String(s.oneLine).padStart(5)} ${String(s.repeated).padStart(7)} ${String(s.zero).padStart(5)} ${String(multi).padStart(4)}`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
