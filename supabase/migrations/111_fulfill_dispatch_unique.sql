-- 111: 온라인발주 출고 이력 (sig, dispatch_date) 유니크 (2026-09-11 전체 감사 확정)
--  종전 중복 검사는 select-후-insert 라 두 창/두 사용자가 몇 초 간격으로 ④ 출고를 누르면
--  둘 다 통과해 재고가 이중 차감됐다. 코드가 '이력 insert → 재고 insert' 순서로 바뀌었고,
--  이 유니크가 동시 커밋을 DB 차원에서 23505 로 차단한다(코드는 409 '이미 출고됨' 반환).
--  강제 재출고(force)는 같은 날 기록을 새로 만들지 않고 기존 행을 유지한다.
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등(재실행 안전).

-- 적용 순간 이미 같은 (sig, 날짜) 중복 행이 있으면(과거 강제 재출고) 유니크 생성이 실패하므로
-- 최신 1행만 남기고 정리 — 재고 원장(inventory_txns)은 건드리지 않는 이력 정리다.
delete from fulfill_dispatch a
using fulfill_dispatch b
where a.sig = b.sig
  and a.dispatch_date = b.dispatch_date
  and (a.created_at < b.created_at
       or (a.created_at = b.created_at and a.ctid < b.ctid)); -- 동시각 이론적 동률까지 커버

drop index if exists idx_fulfill_dispatch_sig;
create unique index if not exists fulfill_dispatch_sig_date_uniq
  on fulfill_dispatch (sig, dispatch_date);

notify pgrst, 'reload schema';
