-- 136 생산 요청서 — 재시도 키 + 프로모션 합류 완료 표시·실행 클레임 (2026-10-11 원장 점검 G4)
--
-- ■ 왜
--   ① 요청서 만들기가 알림 지연 등으로 오류처럼 보인 뒤 다시 누르면 같은 요청서가 두 장 생겼다(요청 키·유니크 없음, S2).
--      두 장이면 입고 예정이 두 배라 권장이 과소해지고 제조사에 중복 전달된다. 주간 AI 초안도 '조회 후 삽입'이라
--      동시에 두 번 불리면 두 장이 생길 수 있었다.
--   ② 프로모션 요청서 '마감'·'취소'는 상태 저장과 소매 합류가 따로 실행된다(S3). 그 사이 서버 함수가 끊기면
--      요청서는 닫혔는데 확보분은 프로모션 칸에 남고, 흔적이 없어 아무도 모른다.
--   ③ 마감 응답이 끊겨 서버가 아직 합류 중일 때 [합류 다시 실행]을 누르거나 두 사람이 함께 누르면 같은 프로모션 풀을
--      두 번 옮겨 소매 재고가 그만큼 부풀었다(실행 표시가 없어 동시 실행을 못 막음, S2).
--
-- ■ 바뀌는 것
--   · production_requests.client_key — 화면이 창을 열 때 만든 키(재시도에도 같은 키). 같은 키 두 번째 저장은
--     새로 만들지 않고 첫 요청서를 돌려준다. 주간 초안은 'ai-draft-YYYY-MM-DD'. 취소하면 초안 키는 비운다(다시 만들 수 있게).
--   · production_requests.promo_released_at — 프로모션 마감·취소의 소매 합류가 끝난 시각. 마감 직전에 비우고
--     합류가 실패 없이 끝나면 채운다. '닫힘인데 비어 있음' = 합류 미확인 → 생산 요청 목록 배지·[합류 다시 실행]·
--     B2B 일정 알림에 뜬다. (남길 몫 계산에는 쓰지 않는다 — 다른 열린 요청서의 이행 순합(배정 + 음수 연결)으로 센다.)
--   · production_requests.promo_release_started_at — 합류 실행 시작 시각(실행 클레임). 마감과 [합류 다시 실행]이 채우고,
--     70초 안(라우트 최대 실행 60초 + 여유)의 두 번째 실행은 '합류가 진행 중입니다'로 막는다. 실패로 끝나면 비운다.
--   · 컬럼을 처음 만들 때 한 번만, 이미 닫혀 있는 프로모션 요청서는 합류가 끝난 것으로 채운다(과거 건이 미확인으로 뜨지 않게).
--   코드는 136 미적용이어도 동작한다(키 없이 생성·합류 표시·실행 클레임 없음 — 종전 동작).
--   이미 이 파일을 한 번 붙여넣었다면 다시 Run 하면 된다(promo_release_started_at 만 새로 생긴다).
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(재실행 안전 — 채우기는 컬럼을 처음 만들 때만 돈다).

alter table public.production_requests add column if not exists client_key text;
create unique index if not exists production_requests_client_key_uniq
  on public.production_requests (client_key) where client_key is not null;
comment on column public.production_requests.client_key is
  '생성 재시도 키 — 같은 키로 두 번 저장해도 요청서는 한 장(화면 UUID, 주간 초안 ai-draft-날짜). 초안 취소 시 비움';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'production_requests' and column_name = 'promo_released_at'
  ) then
    alter table public.production_requests add column promo_released_at timestamptz;
    update public.production_requests
       set promo_released_at = updated_at
     where purpose = '프로모션' and status in ('완료', '취소');
  end if;
end $$;
comment on column public.production_requests.promo_released_at is
  '프로모션 마감·취소의 소매 합류 완료 시각 — 닫힌 프로모션인데 null 이면 합류 미확인(다시 실행 대상)';

alter table public.production_requests add column if not exists promo_release_started_at timestamptz;
comment on column public.production_requests.promo_release_started_at is
  '프로모션 소매 합류 실행 시작 시각(실행 클레임) — 70초 안의 두 번째 합류 실행을 막는다. 실패로 끝나면 null';

notify pgrst, 'reload schema';
