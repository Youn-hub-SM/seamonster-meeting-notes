-- factory/006 품목 '규격' 칸 (2026-10-22 대표 지시 — 입고·상품마스터에서 규격을 넣는다)
--
-- ■ 하는 일
--   1) factory.products.spec(text) 추가 — 자유 입력(예: 150/200, 블록, IQF, 탈피). 로트 구분엔 안 쓴다(로트 = 품목 × 제조일자 × 박스 중량 그대로).
--   2) 품목 변경 이력 트리거(log_product_change)에 spec 비교를 넣는다 — 바꾸면 히스토리 '변경'에 남는다.
--
-- ■ 코드 폴백: 이 파일을 적용하기 전에도 화면·API 는 죽지 않는다(spec 칸만 비어 보이고, 저장 때 spec 을 빼고 다시 저장).
-- ■ factory 번호열은 factory 스키마 밖(public)을 건드리지 않는다(CLAUDE.md §3a).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table factory.products add column if not exists spec text;
comment on column factory.products.spec is '규격(자유 입력: 150/200·블록·IQF·탈피 등). 로트 구분에는 쓰지 않는다';

create or replace function factory.log_product_change()
returns trigger
language plpgsql
set search_path = factory, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into factory.product_changes (product_id, sku, name, field, new_value, changed_by)
    values (new.id, new.sku, new.name, '등록',
      nullif(concat_ws(' · ',
        case when new.spec is not null then '규격 ' || new.spec end,
        case when new.cost is not null then '원가 ' || to_char(new.cost, 'FM999,999,999,999') || '원' end,
        case when new.price is not null then '판매가 ' || to_char(new.price, 'FM999,999,999,999') || '원' end), ''),
      new.created_by);
    return new;
  end if;
  insert into factory.product_changes (product_id, sku, name, field, old_value, new_value, changed_by)
  select new.id, new.sku, new.name, v.f, v.o, v.n, new.updated_by
  from (values
    ('sku', old.sku, new.sku),
    ('name', old.name, new.name),
    ('spec', old.spec, new.spec),
    ('origin', old.origin, new.origin),
    ('note', old.note, new.note),
    ('cost', old.cost::text, new.cost::text),
    ('price', old.price::text, new.price::text),
    ('stock_tracked', case when old.stock_tracked then '사용' else '사용안함' end, case when new.stock_tracked then '사용' else '사용안함' end)
  ) as v(f, o, n)
  where v.o is distinct from v.n;
  return new;
end;
$$;

notify pgrst, 'reload schema';
