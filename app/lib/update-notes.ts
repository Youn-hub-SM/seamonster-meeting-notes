// 업데이트 노트를 Supabase 표(update_notes, migration 171)에 기록한다 — 2026-11-19 대표: "업데이트 노트를 슈파베이스에 기록만 하면 돼".
//  쓰는 곳은 그대로 changelog.ts. 여기서는 그 파일에 있는데 표에 없는 항목만 추가한다(한 번 들어간 줄은 고치거나 지우지 않는다).
//  운영에서만 쓴다 — 베타도 같은 DB 를 쓰므로, 베타가 쓰면 아직 운영에 안 나간 소식이 들어간다.
//  부르는 곳: 일정 알림 크론의 정각 칸(한 시간에 한 번). 화면(/updates)은 이 표를 읽지 않는다.
import { createHash } from "node:crypto";
import { supabaseAdmin } from "./supabase";
import { CHANGELOG } from "./changelog";

const TABLE = "update_notes";
const PAGE = 1000;

// 추가한 건수를 돌려준다. 표가 없으면(171 미적용) 0 — 조용히 건너뛴다.
export async function recordUpdateNotes(): Promise<number> {
  if (process.env.VERCEL_ENV !== "production") return 0;
  const sb = supabaseAdmin();

  const have = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(TABLE).select("id").order("id").range(from, from + PAGE - 1);
    if (error) {
      if (error.code === "PGRST205" || error.code === "42P01" || /(does not exist|schema cache|could not find)/i.test(error.message || "")) return 0;
      throw new Error(`업데이트 노트 표 읽기 실패: ${error.message}`);
    }
    for (const r of (data ?? []) as { id: string }[]) have.add(r.id);
    if (!data || data.length < PAGE) break;
  }

  const fresh = new Map<string, Record<string, string | null>>();
  for (const e of CHANGELOG) {
    const id = createHash("sha256").update(`${e.date}|${e.tool}|${e.title}`).digest("hex").slice(0, 16);
    if (!have.has(id) && !fresh.has(id)) fresh.set(id, { id, note_date: e.date, tag: e.tag, tool: e.tool, title: e.title, body: e.desc, href: e.href ?? null });
  }
  const rows = [...fresh.values()];
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from(TABLE).upsert(rows.slice(i, i + 200), { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error(`업데이트 노트 표 쓰기 실패: ${error.message}`);
  }
  return rows.length;
}
