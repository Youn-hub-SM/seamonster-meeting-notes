-- 130 볼타 세금계산서 발행 기능 삭제 — 128 이 만든 것 정리 (2026-10-11 대표 결정)
--
-- ■ 왜
--   볼타(Bolta) API 로 세금계산서를 바로 발행하는 기능을 쓰지 않기로 해 코드에서 모두 뺐다(베타에만 있었고 운영엔 나간 적 없음).
--   128 이 만든 발행 기록 표(tax_invoices)와 거래처 계산서 칸 6개를 지운다. 128 파일은 적용 이력이라 남겨 둔다.
--
-- ■ 지우기 전에 옮기는 것 (값을 잃지 않게)
--   0) 라이브(국세청 전송) 발행 기록이 하나라도 있으면 아무것도 바꾸지 않고 오류로 멈춘다(목록을 보여 줌).
--      처리 중·발행됨 문서의 기록이 사라지면 홈택스에서 중복 발행할 수 있어서다 — 볼타에서 확인한 뒤 따로 정리한다.
--   1) 발주 세금계산서 상태가 '발행대기'(볼타 발행 중)로 남은 발주 → '미발행'(테스트 키는 발주 상태를 바꾸지 않았으므로 보통 0건).
--   2) 거래처 계산서 칸에 값이 있으면 메모(notes) 끝에 한 줄로 붙인다 — 업태·종목은 예전 사업자등록증 판독과 같은 '업태: … / 종목: …' 형식.
--      128 이 메모에서 옮겨 채운 값처럼 메모에 이미 같은 글이 있으면 다시 붙이지 않는다.
--      사업장 주소·계산서 이메일·담당자·전화는 기본 배송지·담당자 정보와 같으면 붙이지 않는다(같은 값이 이미 있으므로).
--   3) 설정 › 거래명세표 공급자에 넣은 '세금계산서 담당자·연락처'(manager·phone)를 지운다.
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전(128 미적용이어도 에러 없음).

-- 0)·1) 라이브 기록 확인 + '발행대기' 발주 정리
do $$
declare
  n_wait int := 0;
begin
  if to_regclass('public.tax_invoices') is not null then
    -- 라이브(국세청 전송) 기록이 하나라도 있으면 멈춘다 — 처리 중·발행됨 문서의 관리번호·승인번호가 표와 함께 사라지면
    --  발주 상태로는 발행 여부를 알 수 없어 홈택스에서 중복 발행할 수 있다. 목록을 보고 볼타에서 확인한 뒤 알려 줄 것.
    if exists (select 1 from public.tax_invoices where mode = 'live') then
      raise exception '라이브 발행 기록이 있어 멈춥니다(아무것도 바뀌지 않음) — %',
        (select string_agg(coalesce(order_no, '?') || ':' || status || coalesce('/' || fail_code, '')
                           || coalesce(' 접수=' || issuance_key, '') || coalesce(' 승인=' || nts_id, ''), ', ')
           from public.tax_invoices where mode = 'live');
    end if;
  end if;
  update public.orders set tax_invoice_status = '미발행' where tax_invoice_status = '발행대기';
  get diagnostics n_wait = row_count;
  raise notice '발행대기 발주 정리 %건', n_wait;
end $$;

-- 2) 거래처 계산서 칸 → 메모
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'companies' and column_name = 'biz_type') then
    update public.companies c
       set notes = concat_ws(E'\n', nullif(c.notes, ''), x.line)
      from (
        select id, nullif(concat_ws(' / ',
          case when nullif(trim(biz_type), '') is not null
                and position(('업태: ' || trim(biz_type)) in coalesce(notes, '')) = 0 then '업태: ' || trim(biz_type) end,
          case when nullif(trim(biz_item), '') is not null
                and position(('종목: ' || trim(biz_item)) in coalesce(notes, '')) = 0 then '종목: ' || trim(biz_item) end,
          case when nullif(trim(biz_address), '') is not null and trim(biz_address) is distinct from trim(coalesce(address, ''))
                and position(('사업장 주소: ' || trim(biz_address)) in coalesce(notes, '')) = 0 then '사업장 주소: ' || trim(biz_address) end,
          case when nullif(trim(tax_email), '') is not null and trim(tax_email) is distinct from trim(coalesce(contact_email, ''))
                and position(('계산서 이메일: ' || trim(tax_email)) in coalesce(notes, '')) = 0 then '계산서 이메일: ' || trim(tax_email) end,
          case when nullif(trim(tax_manager_name), '') is not null and trim(tax_manager_name) is distinct from trim(coalesce(contact_name, ''))
                and position(('계산서 담당자: ' || trim(tax_manager_name)) in coalesce(notes, '')) = 0 then '계산서 담당자: ' || trim(tax_manager_name) end,
          case when nullif(trim(tax_manager_phone), '') is not null and trim(tax_manager_phone) is distinct from trim(coalesce(contact_phone, ''))
                and position(('계산서 담당자 전화: ' || trim(tax_manager_phone)) in coalesce(notes, '')) = 0 then '계산서 담당자 전화: ' || trim(tax_manager_phone) end
        ), '') as line
        from public.companies
      ) x
     where x.id = c.id and x.line is not null;
  end if;
end $$;

-- 3) 거래명세표 공급자 설정에서 세금계산서 담당자·연락처 빼기 (value = {"v": "<JSON 문자열>"})
do $$
declare raw text;
begin
  select value->>'v' into raw from public.b2b_settings where key = 'statement_supplier';
  if raw is not null and raw ~ '^\s*\{' then
    begin
      if (raw::jsonb) ?| array['manager', 'phone'] then
        update public.b2b_settings
           set value = jsonb_build_object('v', ((raw::jsonb) - 'manager' - 'phone')::text), updated_at = now()
         where key = 'statement_supplier';
      end if;
    exception when others then
      raise notice '거래명세표 공급자 설정을 읽지 못해 그대로 둡니다(%).', sqlerrm;
    end;
  end if;
end $$;

-- 4) 표·칸 삭제
drop table if exists public.tax_invoices;   -- 인덱스·RLS 정책도 함께 지워진다

alter table public.companies
  drop column if exists biz_type,
  drop column if exists biz_item,
  drop column if exists biz_address,
  drop column if exists tax_email,
  drop column if exists tax_manager_name,
  drop column if exists tax_manager_phone;

notify pgrst, 'reload schema';
