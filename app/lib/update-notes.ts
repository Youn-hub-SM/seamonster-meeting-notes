// 업데이트 노트 표(update_notes, migration 171) — 코드 파일(changelog.ts)의 사본을 Supabase 에 둔다(2026-11-19 대표: "슈파베이스에 쌓이도록 하자. 이걸 지피티도 읽을 거야").
//  쓰는 곳은 그대로 changelog.ts 다. 여기서는 ① 파일과 표를 견줘 다른 줄만 넣고·고치고·지우는 맞추기와 ② 표에서 읽기(지피티 MCP 도구)만 한다.
//  맞추기는 운영에서만 쓴다 — 베타도 같은 DB 를 쓰므로, 베타가 쓰면 아직 운영에 안 나간 소식이 표에 들어간다.
//  부르는 곳: 일정 알림 크론의 정각 칸(한 시간에 한 번), 관리자 수동 /api/updates/sync. 화면(/updates)은 이 표를 읽지 않는다(코드 파일 그대로 — 호출이 늘지 않게).
import { createHash } from "node:crypto";
import { supabaseAdmin } from "./supabase";
import { CHANGELOG, changeMenu } from "./changelog";

const TABLE = "update_notes";
const PAGE = 1000;

export type UpdateNoteRow = {
  id: string; note_date: string; tag: string; tool: string; menu: string;
  title: string; body: string; href: string | null; seq: number; hash: string;
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// 코드 파일 → 표의 줄. id = 날짜·도구·제목(같은 항목은 늘 같은 id — 설명만 고치면 같은 줄이 고쳐진다). seq = 오래된 것부터 1(맨 위에 새 항목을 넣어도 옛 줄의 값이 안 바뀐다).
export function notesFromCode(): UpdateNoteRow[] {
  const used = new Map<string, number>();
  const n = CHANGELOG.length;
  return CHANGELOG.map((e, i) => {
    const base = sha(`${e.date}|${e.tool}|${e.title}`).slice(0, 16);
    const dup = used.get(base) || 0;
    used.set(base, dup + 1);
    const row = {
      id: dup ? `${base}-${dup + 1}` : base,
      note_date: e.date, tag: e.tag, tool: e.tool, menu: changeMenu(e.tool),
      title: e.title, body: e.desc, href: e.href ?? null, seq: n - i,
    };
    return { ...row, hash: sha(JSON.stringify([row.note_date, row.tag, row.tool, row.menu, row.title, row.body, row.href, row.seq])).slice(0, 32) };
  });
}

const errText = (e: unknown) => (e instanceof Error ? e.message : (e as { message?: string } | null)?.message || String(e));
// 표가 아직 없다(171 미적용) — 맞추기는 조용히 건너뛰고, 읽기는 코드 파일로 답한다
const isMissingTable = (e: unknown) => {
  const o = (e || {}) as { code?: string; message?: string };
  return o.code === "PGRST205" || o.code === "42P01" || (/update_notes/.test(o.message || "") && /(does not exist|schema cache|could not find)/i.test(o.message || ""));
};

export type SyncResult = { ok: boolean; skipped?: "no-table"; wrote: boolean; total: number; inserted: number; updated: number; deleted: number };

// 파일과 표를 견줘 다른 줄만 맞춘다. write=false 면 무엇이 바뀔지 세기만 한다.
//  읽기에 실패하면 던진다 — 반쯤 읽은 목록으로 지우기를 하면 멀쩡한 줄이 사라진다.
export async function syncUpdateNotes(opts?: { write?: boolean }): Promise<SyncResult> {
  const write = opts?.write ?? process.env.VERCEL_ENV === "production";
  const rows = notesFromCode();
  if (!rows.length) throw new Error("업데이트 노트가 비어 있습니다 — 표를 비우지 않도록 멈춥니다.");
  const sb = supabaseAdmin();

  const have = new Map<string, string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(TABLE).select("id, hash").order("id").range(from, from + PAGE - 1);
    if (error) {
      if (isMissingTable(error)) return { ok: true, skipped: "no-table", wrote: false, total: rows.length, inserted: 0, updated: 0, deleted: 0 };
      throw new Error(`업데이트 노트 표 읽기 실패: ${errText(error)}`);
    }
    for (const r of (data ?? []) as { id: string; hash: string }[]) have.set(r.id, r.hash);
    if (!data || data.length < PAGE) break;
  }

  const ids = new Set(rows.map((r) => r.id));
  const fresh = rows.filter((r) => !have.has(r.id));
  const changed = rows.filter((r) => have.has(r.id) && have.get(r.id) !== r.hash);
  const gone = [...have.keys()].filter((id) => !ids.has(id));
  const out: SyncResult = { ok: true, wrote: write, total: rows.length, inserted: fresh.length, updated: changed.length, deleted: gone.length };
  if (!write || (!fresh.length && !changed.length && !gone.length)) return out;

  const now = new Date().toISOString();
  // created_at 은 보내지 않는다 — 새 줄은 기본값(now), 고쳐지는 줄은 처음 들어온 시각을 지킨다
  const put = [...fresh, ...changed].map((r) => ({ ...r, updated_at: now }));
  for (let i = 0; i < put.length; i += 200) {
    const { error } = await sb.from(TABLE).upsert(put.slice(i, i + 200), { onConflict: "id" });
    if (error) throw new Error(`업데이트 노트 표 쓰기 실패: ${errText(error)}`);
  }
  for (let i = 0; i < gone.length; i += 200) {
    const { error } = await sb.from(TABLE).delete().in("id", gone.slice(i, i + 200));
    if (error) throw new Error(`업데이트 노트 표 지우기 실패: ${errText(error)}`);
  }
  return out;
}

export type NotesQuery = { since?: string | null; until?: string | null; menu?: string | null; q?: string | null; limit?: number };
export type NotesAnswer = { source: "table" | "code"; matched: number; rows: UpdateNoteRow[] };   // matched = 조건에 맞는 전체 건수(rows 는 그중 최신 limit 건)

const pick = (all: UpdateNoteRow[], qy: NotesQuery, limit: number): { matched: number; rows: UpdateNoteRow[] } => {
  const menu = (qy.menu || "").replace(/\s/g, "").toLowerCase();
  const word = (qy.q || "").trim().toLowerCase();
  const hit = all.filter((r) =>
    (!qy.since || r.note_date >= qy.since) && (!qy.until || r.note_date <= qy.until)
    && (!menu || r.menu.replace(/\s/g, "").toLowerCase().includes(menu) || r.tool.replace(/\s/g, "").toLowerCase().includes(menu))
    && (!word || `${r.title} ${r.body} ${r.tool}`.toLowerCase().includes(word)),
  );
  return { matched: hit.length, rows: hit.slice(0, limit) };
};

// 표에서 최신순으로 읽는다(지피티 MCP 도구). 표가 없거나 비었으면 코드 파일로 답한다 — 171 적용 전에도 도구가 죽지 않게.
//  메뉴·낱말 거르기는 여기서 한다(표가 작다 — 수백 줄. 검색어를 조회 조건에 섞지 않으니 따옴표·쉼표 걱정이 없다).
export async function readUpdateNotes(qy: NotesQuery): Promise<NotesAnswer> {
  const limit = Math.max(1, Math.min(200, Math.floor(qy.limit || 30)));
  const fromCode = (): NotesAnswer => { return { source: "code", ...pick(notesFromCode(), qy, limit) }; };
  try {
    const all: UpdateNoteRow[] = [];
    for (let from = 0; ; from += PAGE) {
      let s = supabaseAdmin().from(TABLE).select("id, note_date, tag, tool, menu, title, body, href, seq, hash")
        .order("note_date", { ascending: false }).order("seq", { ascending: false }).range(from, from + PAGE - 1);
      if (qy.since) s = s.gte("note_date", qy.since);
      if (qy.until) s = s.lte("note_date", qy.until);
      const { data, error } = await s;
      if (error) { if (!isMissingTable(error)) console.error("[update-notes] 표 읽기 실패 — 코드 파일로 답함", errText(error)); return fromCode(); }
      all.push(...((data ?? []) as UpdateNoteRow[]));
      if (!data || data.length < PAGE) break;
    }
    if (!all.length) return fromCode();   // 표가 아직 안 채워졌을 수 있다 — 코드 파일로 같은 조건을 다시 본다(맞춰진 표라면 결과가 같다)
    return { source: "table", ...pick(all, { ...qy, since: null, until: null }, limit) };
  } catch (e) {
    console.error("[update-notes] 표 읽기 실패 — 코드 파일로 답함", errText(e));
    return fromCode();
  }
}
