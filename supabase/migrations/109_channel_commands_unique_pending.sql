-- 109: 채널 재고 명령 — 같은 상품의 '대기' 명령 중복 금지 (안전성 감사 후속)
--
-- 두 사용자가 같은 리스팅에 거의 동시에 수량을 적용하면 갱신(bump)-후-insert 가
-- 비원자라 '대기' 명령이 2건 생길 수 있다 — 실행 순서에 따라 최종 채널 재고가 복불복.
-- 부분 유니크 인덱스로 DB 가 중복을 막고, API 는 충돌(23505) 시 기존 행 갱신으로 폴백한다.
--
-- 적용: Supabase SQL Editor 에 붙여넣어 실행.

-- 적용 순간에 이미 중복 '대기' 가 있으면 index 생성이 실패하므로, 옛 쪽을 먼저 정리한다
delete from channel_commands a
using channel_commands b
where a.channel = b.channel
  and a.item_key = b.item_key
  and a.status = '대기'
  and b.status = '대기'
  and (a.created_at < b.created_at or (a.created_at = b.created_at and a.id < b.id));

create unique index if not exists channel_commands_pending_uniq
  on channel_commands (channel, item_key)
  where status = '대기';
