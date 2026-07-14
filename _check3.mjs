import pg from "pg";
const c = new pg.Client({
  host: "aws-1-ap-northeast-2.pooler.supabase.com", port: 5432,
  user: "looker_ro.uwbkejkztuhzcesrffzq", password: "Tlahstmxjdbsgustjrdlqslek",
  database: "postgres", ssl: { rejectUnauthorized: false },
});
await c.connect();
const q = async (label, sql) => { try { const r = await c.query(sql); console.log(`\n== ${label} ==`); console.table(r.rows); } catch(e){ console.log(`\n== ${label} == ERR ${e.message}`); } };
await q("이 DB 식별(호스트/최신주문일 = 서울 프로젝트 맞는지)", `select current_database() db, (select max(order_date) from sales_looker) latest_order, (select count(*) from sales_looker) rows`);
await q("sales_group_repeat 존재?", `select to_regclass('public.sales_group_repeat') as view_exists`);
await q("repeat_label 함수 존재?", `select count(*) fn from pg_proc where proname='repeat_label'`);
await q("public 스키마 뷰 전체", `select table_name from information_schema.views where table_schema='public' order by table_name`);
await c.end();
