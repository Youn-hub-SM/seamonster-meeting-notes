# 마이그레이션 파일들이 만들기로 한 표·칸·함수·색인·뷰·제약이 DB 에 실제로 있는지 보는 '읽기 전용' 점검 SQL 을 만든다.
#  순서대로 읽어, 나중 파일이 지운 것(drop)은 기대 목록에서 뺀다. 함수는 마지막 정의의 본문(공백 무시)까지 견준다.
import io, os, re, hashlib, sys
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))).replace("\\", "/") + "/"
MIG = ROOT + "supabase/migrations/"
OUT = sys.argv[1] if len(sys.argv) > 1 else ROOT + "supabase/checks/schema-check.sql"

def files():
    main = sorted(f for f in os.listdir(MIG) if f.endswith(".sql"))
    out = [(f, MIG + f, "public") for f in main]
    for sub in ("factory", "hr"):
        d = MIG + sub + "/"
        if os.path.isdir(d): out += [(f"{sub}/{f}", d + f, sub) for f in sorted(os.listdir(d)) if f.endswith(".sql")]
    return out

IDENT = r'(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)'
QNAME = rf'(?:(?P<s>{IDENT})\.)?(?P<n>{IDENT})'
def qn(m, default):
    s = (m.group("s") or default).strip('"').lower(); n = m.group("n").strip('"').lower()
    return s, n

def strip_comments(sql):
    # $태그$ … $태그$ 안은 그대로 두고, 그 밖의 -- 줄 주석과 /* */ 만 지운다(문자열 안의 -- 는 드물어 무시)
    parts = re.split(r'(\$[a-zA-Z_]*\$)', sql)
    out, inside, tag = [], False, None
    for p in parts:
        if re.fullmatch(r'\$[a-zA-Z_]*\$', p):
            if not inside: inside, tag = True, p
            elif p == tag: inside, tag = False, None
            out.append(p); continue
        out.append(p if inside else re.sub(r'/\*.*?\*/', ' ', re.sub(r'--[^\n]*', '', p), flags=re.S))
    return "".join(out)

tables, columns, funcs, indexes, views, checks = {}, {}, {}, {}, {}, {}
# 값 = 그것을 (마지막으로) 만든 파일 이름

for name, path, default in files():
    raw = io.open(path, encoding="utf-8").read().replace("\r\n", "\n")
    sql = strip_comments(raw)
    sp = re.search(r'set\s+search_path\s*(?:=|to)\s*([a-zA-Z_]+)', sql, re.I)
    dflt = default  # 파일 안 set search_path 는 함수 속성으로도 쓰여 믿지 않는다 — 번호열의 스키마를 기본으로
    # 문장 단위가 아니라 등장 순서대로 훑는다
    events = []
    for m in re.finditer(rf'create\s+table\s+(?:if\s+not\s+exists\s+)?{QNAME}', sql, re.I): events.append((m.start(), "t+", qn(m, dflt), None))
    for m in re.finditer(rf'drop\s+table\s+(?:if\s+exists\s+)?{QNAME}', sql, re.I): events.append((m.start(), "t-", qn(m, dflt), None))
    for m in re.finditer(rf'alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?{QNAME}(?P<body>[^;]*);', sql, re.I | re.S):
        t = qn(m, dflt); body = m.group("body")
        for c in re.finditer(rf'add\s+column\s+(?:if\s+not\s+exists\s+)?({IDENT})', body, re.I): events.append((m.start() + c.start(), "c+", t, c.group(1).strip('"').lower()))
        for c in re.finditer(rf'drop\s+column\s+(?:if\s+exists\s+)?({IDENT})', body, re.I): events.append((m.start() + c.start(), "c-", t, c.group(1).strip('"').lower()))
        for c in re.finditer(rf'rename\s+column\s+({IDENT})\s+to\s+({IDENT})', body, re.I): events.append((m.start() + c.start(), "cr", t, (c.group(1).strip('"').lower(), c.group(2).strip('"').lower())))
        for c in re.finditer(rf'rename\s+to\s+({IDENT})', body, re.I):
            if not re.search(r'rename\s+column', body[max(0, c.start() - 40):c.end()], re.I): events.append((m.start() + c.start(), "tr", t, c.group(1).strip('"').lower()))
        for c in re.finditer(rf'add\s+constraint\s+({IDENT})\s+check\s*\(', body, re.I):
            # 괄호 짝 맞춰 본문 끝까지
            i = m.start("body") + c.end(); depth = 1; j = i
            while j < len(sql) and depth: depth += (sql[j] == "(") - (sql[j] == ")"); j += 1
            lits = sorted(set(re.findall(r"'([^']+)'", sql[i:j])))
            events.append((m.start() + c.start(), "k+", t, (c.group(1).strip('"').lower(), lits)))
        for c in re.finditer(rf'drop\s+constraint\s+(?:if\s+exists\s+)?({IDENT})', body, re.I): events.append((m.start() + c.start(), "k-", t, c.group(1).strip('"').lower()))
    for m in re.finditer(rf'create\s+(?:or\s+replace\s+)?function\s+{QNAME}\s*\(', sql, re.I):
        f = qn(m, dflt)
        tail = sql[m.end():]
        b = re.search(r'\bas\s+(\$[a-zA-Z_]*\$)', tail, re.I)
        body = None
        if b:
            end = tail.find(b.group(1), b.end())
            if end > 0: body = tail[b.end():end]
        events.append((m.start(), "f+", f, body))
    for m in re.finditer(rf'drop\s+function\s+(?:if\s+exists\s+)?{QNAME}', sql, re.I): events.append((m.start(), "f-", qn(m, dflt), None))
    for m in re.finditer(rf'create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?P<i>{IDENT})\s+on\s+(?:only\s+)?{QNAME}', sql, re.I):
        events.append((m.start(), "i+", (qn(m, dflt)[0], m.group("i").strip('"').lower()), qn(m, dflt)))
    for m in re.finditer(rf'drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?{QNAME}', sql, re.I): events.append((m.start(), "i-", qn(m, dflt), None))
    for m in re.finditer(rf'create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+{QNAME}', sql, re.I): events.append((m.start(), "v+", qn(m, dflt), None))
    for m in re.finditer(rf'drop\s+(?:materialized\s+)?view\s+(?:if\s+exists\s+)?{QNAME}', sql, re.I): events.append((m.start(), "v-", qn(m, dflt), None))

    for _, kind, key, extra in sorted(events, key=lambda e: e[0]):
        if kind == "t+": tables.setdefault(key, name)
        elif kind == "t-":
            tables.pop(key, None)
            for k in [k for k in columns if k[:2] == key]: columns.pop(k)
            for k in [k for k in checks if k[:2] == key]: checks.pop(k)
            for k in [k for k, v in indexes.items() if v[1] == key]: indexes.pop(k)
        elif kind == "tr":
            if key in tables: tables[(key[0], extra)] = tables.pop(key)
            for k in [k for k in columns if k[:2] == key]: columns[(key[0], extra, k[2])] = columns.pop(k)
        elif kind == "c+": columns.setdefault((*key, extra), name)
        elif kind == "c-": columns.pop((*key, extra), None)
        elif kind == "cr":
            old, new = extra
            columns[(*key, new)] = columns.pop((*key, old), name)
        elif kind == "f+": funcs[key] = (name, extra)
        elif kind == "f-": funcs.pop(key, None)
        elif kind == "i+": indexes.setdefault(key, (name, extra))
        elif kind == "i-": indexes.pop(key, None)
        elif kind == "v+": views[key] = name
        elif kind == "v-": views.pop(key, None)
        elif kind == "k+": checks[(*key, extra[0])] = (name, extra[1])
        elif kind == "k-": checks.pop((*key, extra), None)

q = lambda s: "'" + s.replace("'", "''") + "'"
norm = lambda body: hashlib.md5(re.sub(r'[ \t\n\r\f\v]+', '', body).encode("utf-8")).hexdigest()  # 아스키 공백만 — DB 쪽 정규식과 같은 글자
rows = []
for (s, t), f in tables.items(): rows.append(("표", s, t, "", "", f))
for (s, t, c), f in columns.items():
    if (s, t) in tables or True: rows.append(("칸", s, t, c, "", f))
for (s, n), (f, body) in funcs.items(): rows.append(("함수", s, n, "", norm(body) if body is not None else "", f))
for (s, n), (f, _t) in indexes.items(): rows.append(("색인", s, n, "", "", f))
for (s, n), f in views.items(): rows.append(("뷰", s, n, "", "", f))
for (s, t, k), (f, lits) in checks.items(): rows.append(("제약", s, t, k, "~|~".join(lits), f))
rows.sort(key=lambda r: (r[5].count("/"), r[5], r[0], r[2], r[3]))

values = ",\n".join(f"  ({q(k)}, {q(s)}, {q(o)}, {q(c)}, {q(x)}, {q(f)})" for k, s, o, c, x, f in rows)
sql = f"""-- 마이그레이션 적용 점검(읽기 전용) — supabase/migrations 의 파일들이 만들기로 한 것 중 DB 에 없는 것을 찾는다.
--   쓰는 법: Supabase SQL Editor 에 이 파일 전체를 붙여 넣고 Run. 아무것도 바꾸지 않는다(select 한 번).
--   결과가 0줄이면 빠진 것이 없다. 줄이 나오면 '파일' 칸의 마이그레이션이 적용되지 않았거나 옛 판이 적용된 것이다.
--   종류: 표 · 칸 · 함수(없음 / 본문이 최신 파일과 다름) · 색인 · 뷰 · 제약(없음 / 허용 값이 최신 파일과 다름)
--   못 보는 것: 데이터를 고치는 문장(update·insert), 권한·정책(RLS·grant), pg_cron 예약, 뷰의 본문.
--   만든 날: 2026-11-25 · 기대 목록 {len(rows)}개(표 {len(tables)} · 칸 {len(columns)} · 함수 {len(funcs)} · 색인 {len(indexes)} · 뷰 {len(views)} · 제약 {len(checks)})
--   마이그레이션을 새로 더하면 이 파일도 다시 만들어야 한다(같은 폴더의 gen-schema-check.py 를 돌리면 된다).
with expected(kind, sch, obj, sub, extra, file) as (values
{values}
), found as (
  select e.*,
    case e.kind
      when '표' then not exists (select 1 from information_schema.tables t where t.table_schema = e.sch and t.table_name = e.obj)
      when '칸' then not exists (select 1 from information_schema.columns c where c.table_schema = e.sch and c.table_name = e.obj and c.column_name = e.sub)
      when '함수' then not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = e.sch and p.proname = e.obj)
      when '색인' then not exists (select 1 from pg_indexes i where i.schemaname = e.sch and i.indexname = e.obj)
      when '뷰' then not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = e.sch and c.relname = e.obj and c.relkind in ('v', 'm'))
      when '제약' then not exists (select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = e.sch and c.relname = e.obj and k.conname = e.sub)
    end as missing,
    case
      when e.kind = '함수' and e.extra <> '' then not exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = e.sch and p.proname = e.obj and md5(regexp_replace(p.prosrc, '[ \\t\\n\\r\\f\\v]+', '', 'g')) = e.extra)
      when e.kind = '제약' and e.extra <> '' then exists (
        select 1 from unnest(string_to_array(e.extra, '~|~')) as lit
        where not exists (
          select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = e.sch and c.relname = e.obj and k.conname = e.sub and position(lit in pg_get_constraintdef(k.oid)) > 0))
      else false
    end as outdated
  from expected e
)
select file as "파일", kind as "종류", sch as "스키마",
       case when kind in ('칸', '제약') then obj || '.' || sub else obj end as "이름",
       case when missing then '없음' when kind = '함수' then '본문이 최신 파일과 다름' else '허용 값이 최신 파일과 다름' end as "상태"
from found
where missing or outdated
order by (file like '%/%'), file, kind, obj, sub;
"""
io.open(OUT, "w", encoding="utf-8", newline="\n").write(sql)
print(f"rows={len(rows)} tables={len(tables)} columns={len(columns)} funcs={len(funcs)} indexes={len(indexes)} views={len(views)} checks={len(checks)} bytes={len(sql.encode('utf-8'))}")
