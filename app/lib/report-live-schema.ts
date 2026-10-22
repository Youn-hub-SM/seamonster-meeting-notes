// AI 비서 — 살아 있는 스키마(2026-10-20 구조 전환). 서버 전용.
//  DB 의 information_schema + 표·컬럼 주석(comment on table/column)을 run_report 로 읽어, 차단 목록(BLOCKED_RELATIONS)만 빼고
//  비서에게 준다. 새 표·새 컬럼은 마이그레이션에 주석 한 줄만 달면 그 자리에서 비서 설명이 된다. 손 카탈로그(SCHEMA_CATALOG)는
//  주석이 없는 표의 보충 설명으로만 쓴다. 10분 캐시. DB 조회에 실패하면 손 카탈로그만으로 동작(비서가 죽지 않는다).
import type { SupabaseClient } from "@supabase/supabase-js";
import { SCHEMA_CATALOG, isBlockedRelation } from "./report-schema";

export type LiveColumn = { name: string; type: string; comment: string | null };
export type LiveRelation = { name: string; kind: "TABLE" | "VIEW"; comment: string | null; columns: LiveColumn[]; fallback: string | null };
export type LiveSchema = { relations: Map<string, LiveRelation>; loadedAt: number; fromDb: boolean };

const CACHE_MS = 10 * 60_000;
let cache: LiveSchema | null = null;
let inflight: Promise<LiveSchema> | null = null;

// 손 카탈로그 → 표별 문단(주석 없는 표의 보충용). 형식: "TABLE name — …" 줄 + 들여쓴 이어지는 줄.
type FallbackEntry = { name: string; kind: "TABLE" | "VIEW"; text: string; desc: string };
function parseFallback(): Map<string, FallbackEntry> {
  const map = new Map<string, FallbackEntry>();
  let cur: FallbackEntry | null = null;
  const flush = () => { if (cur) { cur.text = cur.text.trim(); map.set(cur.name, cur); } cur = null; };
  for (const line of SCHEMA_CATALOG.split("\n")) {
    const head = line.match(/^(TABLE|VIEW)\s+([a-z_][a-z0-9_]*)\s*(?:—\s*(.*))?$/);
    if (head) { flush(); cur = { name: head[2], kind: head[1] as "TABLE" | "VIEW", text: line, desc: (head[3] || "").split(/[.。]\s|\[/)[0].trim().slice(0, 70) }; continue; }
    if (/^##\s/.test(line) || !line.trim()) { flush(); continue; }
    if (cur) cur.text += `\n${line}`;
  }
  flush();
  return map;
}
const FALLBACK = parseFallback();

// 접두 '/*schema*/' = run_report(141)가 information_schema 참조를 허용하는 유일한 표시(서버 고정문)
//  2026-10-20: information_schema 는 함수 소유자의 권한 기준으로 걸러져 0건이 나올 수 있어(베타에서 "조회할 수 있는 표가 없다" 사고)
//  권한에 걸리지 않는 pg_catalog 로 읽는다. 0건이면 실패로 보고 손 설명으로 넘어간다.
//  주의(2026-10-20 사고): 열 별칭에 't' 를 쓰면 안 된다 — run_report 가 결과를 '… from (…) t' 로 감싸고 json_agg(t) 로 묶는데,
//  열 't' 가 있으면 Postgres 가 행이 아니라 그 열을 집계해 문자열 배열이 돌아온다(모든 값 undefined). 별칭은 rel_name 처럼 겹치지 않게.
const SCHEMA_SQL = `/*schema*/ select c.relname as rel_name, a.attname as col_name, pg_catalog.format_type(a.atttypid, a.atttypmod) as col_type, a.attnum as col_pos,
  case when c.relkind in ('v', 'm') then 'VIEW' else 'TABLE' end as rel_kind,
  pg_catalog.obj_description(c.oid, 'pg_class') as rel_comment,
  pg_catalog.col_description(c.oid, a.attnum) as col_comment
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
order by c.relname, a.attnum`;
let lastError: string | null = null;
let lastRows = 0;
export const liveSchemaStatus = () => ({ lastError, lastRows, cachedAt: cache ? new Date(cache.loadedAt).toISOString() : null, fromDb: cache?.fromDb ?? null });

// 자료형 짧게(비서가 읽기 쉽게)
function shortType(raw: string): string {
  const t = raw.replace(/\(.*\)$/, "").replace(/\[\]$/, "[]").trim(); // numeric(14,0)→numeric, character varying(60)→character varying
  const m: Record<string, string> = { "character varying": "text", "timestamp with time zone": "timestamptz", "timestamp without time zone": "timestamp", "double precision": "float", "bigint": "bigint", "integer": "int", "boolean": "bool", "numeric": "numeric", "jsonb": "jsonb", "json": "json", "date": "date", "text": "text", "uuid": "uuid", "ARRAY": "array" };
  return m[t] || t;
}

async function fetchFromDb(sb: SupabaseClient): Promise<Map<string, LiveRelation>> {
  const { data, error } = await sb.rpc("run_report", { q: SCHEMA_SQL, p_limit: 20000 });
  if (error) throw new Error(error.message);
  const rows = (Array.isArray(data) ? data : []) as { rel_name: string; col_name: string; col_type: string; rel_kind: "TABLE" | "VIEW"; rel_comment: string | null; col_comment: string | null }[];
  lastRows = rows.length;
  if (!rows.length) throw new Error("스키마 조회가 0건으로 돌아왔습니다(run_report 권한·141 적용 여부 확인)");
  if (typeof rows[0] !== "object" || rows[0] === null || !("rel_name" in rows[0])) throw new Error("스키마 조회 결과의 모양이 다릅니다(행이 객체가 아님 — 별칭 충돌 의심)");
  const map = new Map<string, LiveRelation>();
  for (const r of rows) {
    const name = String(r.rel_name || "");
    if (!name || isBlockedRelation(name) || /^(pg_|_)/.test(name)) continue;
    let rel = map.get(name);
    if (!rel) { rel = { name, kind: r.rel_kind === "VIEW" ? "VIEW" : "TABLE", comment: r.rel_comment ? String(r.rel_comment).trim() : null, columns: [], fallback: FALLBACK.get(name)?.text ?? null }; map.set(name, rel); }
    rel.columns.push({ name: String(r.col_name), type: shortType(String(r.col_type)), comment: r.col_comment ? String(r.col_comment).trim() : null });
  }
  return map;
}

function fromFallbackOnly(): Map<string, LiveRelation> {
  const map = new Map<string, LiveRelation>();
  for (const e of FALLBACK.values()) if (!isBlockedRelation(e.name)) map.set(e.name, { name: e.name, kind: e.kind, comment: null, columns: [], fallback: e.text });
  return map;
}

export async function loadLiveSchema(sb: SupabaseClient, opts?: { force?: boolean }): Promise<LiveSchema> {
  if (!opts?.force && cache && Date.now() - cache.loadedAt < CACHE_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const relations = await fetchFromDb(sb);
      if (!relations.size) throw new Error("차단 목록을 빼고 남은 표가 없습니다");
      lastError = null;
      cache = { relations, loadedAt: Date.now(), fromDb: true };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.error("[live-schema] DB 스키마 조회 실패 — 손 카탈로그로 대체", lastError);
      cache = { relations: fromFallbackOnly(), loadedAt: Date.now() - CACHE_MS + 60_000, fromDb: false }; // 1분 뒤 재시도
    } finally { inflight = null; }
    return cache!;
  })();
  return inflight;
}

// 표 한 줄 설명(프롬프트 목록용) — 주석 첫 문장 → 손 카탈로그 첫 문장 → '설명 없음'
function oneLine(rel: LiveRelation): string {
  const src = rel.comment || FALLBACK.get(rel.name)?.desc || "";
  const first = src.split(/[.。]\s|\n/)[0].trim();
  return first ? first.slice(0, 90) : "설명 없음(컬럼은 schema 도구로)";
}
export function schemaIndexText(s: LiveSchema): string {
  const names = [...s.relations.keys()].sort();
  return names.map((n) => `- ${n}(${s.relations.get(n)!.kind}): ${oneLine(s.relations.get(n)!)}`).join("\n");
}

// 표 설명 본문(schema 도구) — 주석 + 컬럼(자료형·주석) + 손 카탈로그 보충
export function describeRelation(rel: LiveRelation): string {
  const L: string[] = [`${rel.kind} ${rel.name}${rel.comment ? ` — ${rel.comment}` : ""}`];
  if (rel.columns.length) L.push("  컬럼: " + rel.columns.map((c) => `${c.name}(${c.type}${c.comment ? ` ${c.comment}` : ""})`).join(", "));
  if (rel.fallback && !rel.comment) L.push("  [손 설명] " + rel.fallback.replace(/^(TABLE|VIEW)\s+[a-z0-9_]+\s*—?\s*/, "").replace(/\n\s+/g, " "));
  else if (rel.fallback && rel.comment && /jsonb/.test(rel.fallback) && !/jsonb/.test(rel.comment)) L.push("  [보충] " + rel.fallback.replace(/^(TABLE|VIEW)\s+[a-z0-9_]+\s*—?\s*/, "").replace(/\n\s+/g, " "));
  return L.join("\n");
}
export function describeTables(s: LiveSchema, names: string[]): { found: string[]; missing: string[]; all: string[] } {
  const found: string[] = [], missing: string[] = [];
  for (const n of names) { const rel = s.relations.get(n); if (rel) found.push(describeRelation(rel)); else missing.push(n); }
  return { found, missing, all: [...s.relations.keys()].sort() };
}

// 관리자 점검 — 차단되지 않은 표에서 개인정보·비밀로 의심되는 컬럼 이름
const PII_RE = /(phone|tel\b|mobile|hp\b|email|mail\b|addr|address|zip|postal|receiver|recipient|buyer_name|customer_name|contact|ssn|birth|resident|card_no|account_no|password|passwd|secret|token|api_key|apikey|webhook)/i;
const SAFE_RE = /(_hash$|_key$|^customer_key$|^row_hash$|^member_hash$|_count$|_cnt$)/i; // HMAC·해시·집계는 제외
export function auditPiiColumns(s: LiveSchema): { table: string; column: string }[] {
  const out: { table: string; column: string }[] = [];
  for (const rel of s.relations.values()) for (const c of rel.columns) if (PII_RE.test(c.name) && !SAFE_RE.test(c.name)) out.push({ table: rel.name, column: c.name });
  return out;
}
