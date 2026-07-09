import fs from "fs"; import path from "path";
function loadEnv(){for(const f of[".env.local",".env"]){const p=path.resolve(process.cwd(),f);if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m||process.env[m[1]])continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
async function main(){
  loadEnv();
  const {createClient}=await import("@supabase/supabase-js");
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});

  // 1) inventory_txns 구성
  const {data:txns,error}=await sb.from("inventory_txns").select("type,channel,qty,txn_date,status,partner,product_id");
  if(error){console.error("inventory_txns:",error.message);}
  const T=txns||[];
  const by=(k:(t:any)=>string)=>{const m=new Map<string,{n:number;q:number}>();for(const t of T){const key=k(t);const c=m.get(key)||{n:0,q:0};c.n++;c.q+=Number(t.qty)||0;m.set(key,c);}return m;};
  console.log(`inventory_txns 총 ${T.length}행`);
  console.log("  유형별:", [...by(t=>t.type)].map(([k,v])=>`${k} ${v.n}건(Σqty ${v.q})`).join(" · "));
  console.log("  채널별:", [...by(t=>t.channel||"(null)")].map(([k,v])=>`${k} ${v.n}건`).join(" · "));
  console.log("  상태별:", [...by(t=>t.status||"(null)")].map(([k,v])=>`${k} ${v.n}건`).join(" · "));
  const dates=T.map(t=>t.txn_date).filter(Boolean).sort();
  console.log(`  기간: ${dates[0]||"-"} ~ ${dates[dates.length-1]||"-"} · 품목 ${new Set(T.map(t=>t.product_id)).size}개`);
  // 입고 partner 상위(매입처/생산 구분 힌트)
  const inParts=by(t=>t.type==="입고"?(t.partner||"(빈값)"):"__skip__"); inParts.delete("__skip__");
  console.log("  입고 partner 상위:", [...inParts].sort((a,b)=>b[1].n-a[1].n).slice(0,8).map(([k,v])=>`${k}(${v.n})`).join(" · ")||"(없음)");

  // 2) products SKU
  const {data:prods}=await sb.from("products").select("id,sku,name,active");
  const skuById=new Map<string,string>(); for(const p of prods||[]) skuById.set(p.id,String(p.sku||"").trim());
  const invSkus=new Set([...new Set(T.map(t=>t.product_id))].map(id=>skuById.get(id)).filter(Boolean) as string[]);
  console.log(`\nproducts ${prods?.length||0}개 · 재고원장에 등장하는 SKU ${invSkus.size}개`);

  // 3) sales_orders 최근 90일 판매 SKU/수량 (실제 출고 소스)
  const bounds=(await sb.rpc("sales_date_bounds")).data?.[0];
  const to=bounds?.max_date; const from=to?new Date(new Date(to).getTime()-90*864e5).toISOString().slice(0,10):null;
  console.log(`\nsales_orders 범위 ${bounds?.min_date}~${to} (총 ${bounds?.total_rows}행). 최근90일 ${from}~${to} 집계:`);
  const soldQty=new Map<string,number>();
  if(from){let off=0;for(;off<400000;off+=1000){const {data,error:e2}=await sb.from("sales_orders").select("sku_code,quantity").gte("order_date",from).lte("order_date",to).range(off,off+999);if(e2){console.error(e2.message);break;}if(!data||!data.length)break;for(const r of data){const s=String(r.sku_code||"").trim();if(!s)continue;soldQty.set(s,(soldQty.get(s)||0)+(Number(r.quantity)||0));}if(data.length<1000)break;}}
  console.log(`  판매된 distinct SKU ${soldQty.size}개 · 총수량 ${[...soldQty.values()].reduce((a,b)=>a+b,0).toLocaleString()}`);

  // 4) 교집합: 판매됐는데 재고원장에 입고가 있는지
  const inQtyBySku=new Map<string,number>();
  for(const t of T){if(t.type!=="입고")continue;const s=skuById.get(t.product_id);if(!s)continue;inQtyBySku.set(s,(inQtyBySku.get(s)||0)+(Number(t.qty)||0));}
  let soldNoInbound=0, soldQtyNoInbound=0;
  for(const [s,q] of soldQty){if(!inQtyBySku.get(s)){soldNoInbound++;soldQtyNoInbound+=q;}}
  console.log(`\n정합성 프리뷰:`);
  console.log(`  최근90일 판매된 SKU 중 재고원장 입고기록 '전혀 없음': ${soldNoInbound}개 SKU (판매수량 ${soldQtyNoInbound.toLocaleString()})`);
  const ledgerOut=T.filter(t=>t.type==="출고").reduce((a,t)=>a+Math.abs(Number(t.qty)||0),0);
  console.log(`  재고원장 출고 총량(전체기간): ${ledgerOut.toLocaleString()} vs 실제판매(최근90일): ${[...soldQty.values()].reduce((a,b)=>a+b,0).toLocaleString()}`);
  // 5) production_manual 존재?
  const {data:pm,error:pmE}=await sb.from("production_manual").select("sku,qty,production_date").limit(5);
  console.log(`\nproduction_manual: ${pmE?`없음/에러(${pmE.message})`:`${pm?.length||0}행 샘플 존재`}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
