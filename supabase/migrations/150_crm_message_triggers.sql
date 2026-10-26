-- 150 CRM 메시지맵: 트리거·D+n·목표 클릭률·솔라피 템플릿 ID (2026-10-27, docs/crm-message-map-plan.md 1단계)
--  발송시점(timing 자유 글)을 숫자로 — 한 고객이 며칠에 몇 통 받는지(피로도)와 그 주의 대상자 수(발송 수 추정)를 계산하기 위함.
--  추적 여부는 칸을 두지 않는다: links.utm_campaign 이 있으면 추적 메시지(대표 결정 2026-10-26).

alter table crm_messages add column if not exists trigger text not null default '';            -- signup·first_order·reorder·shipped·delivered·cart·subscription·inactive·event·always
alter table crm_messages add column if not exists offset_days integer;                          -- 기준 사건 뒤 며칠째(음수 = 전). null = 모름/해당 없음
alter table crm_messages add column if not exists offset_note text not null default '';        -- 숫자로 못 담는 조건("2회 구매 시점")
alter table crm_messages add column if not exists target_ctr numeric;                           -- 목표 클릭률(%). null = 목표 없음
alter table crm_messages add column if not exists solapi_template_id text not null default ''; -- 솔라피 카카오 템플릿 ID — 발송 수 자동 연결

comment on column crm_messages.trigger is 'CRM 메시지 트리거(기준 사건): signup 가입·first_order 첫 구매·reorder 재구매·shipped 출고·delivered 배송 완료·cart 장바구니 이탈·subscription 정기배송 회차·inactive 마지막 구매 후 경과·event 행사·always 상시';
comment on column crm_messages.offset_days is '트리거 뒤 며칠째 발송(음수 = 전, 0 = 당일). 피로도 타임라인·대상자 수 추정에 쓴다';
comment on column crm_messages.offset_note is '발송 조건 보조 글(예: 2회 구매 시점)';
comment on column crm_messages.target_ctr is '목표 클릭률(%) — 실제 클릭률(GA 세션 ÷ 발송 수)과 비교';
comment on column crm_messages.solapi_template_id is '솔라피 카카오 템플릿 ID — crm_send_stats(solapi) 의 template 과 맞춰 발송 수를 자동으로 붙인다';
