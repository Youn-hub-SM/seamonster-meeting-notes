-- 153 문서 색인 용량 줄이기 (2026-10-27, 대표: "용량이 너무 클 것 같다")
--  · 소문자 복사본(haystack) 삭제 — ilike 가 대소문자를 무시하므로 불필요했다(저장량 절반)
--  · 본문 상한 60,000자 → 20,000자(이미 저장된 것도 자른다)
--  · 1MB 넘는 데이터 파일(엑셀·CSV·JSON 등)은 이름·경로만 — 이미 본문을 읽은 것은 다시 pending 으로 돌려 코드가 skipped 로 바꾼다
--  152 뒤에 적용.

alter table ms365_doc_index drop column if exists haystack;

update ms365_doc_index set text = left(text, 20000) where length(text) > 20000;

update ms365_doc_index set status = 'pending', text = '', error = ''
 where status = 'ok' and size_kb > 1024 and name ~* '\.(xlsx|xls|csv|json|xml|log|ods)$';

comment on column ms365_doc_index.text is '본문 앞 20,000자(검색용 — 전문은 docs_read 가 Graph 에서 그때 읽는다). skipped·error·pending 은 빈 문자열';
