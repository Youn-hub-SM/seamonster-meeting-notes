// 회사 문서함 본문 색인(2026-10-27) — Graph 드라이브 검색(search(q=))이 사이트별 허용(Sites.Selected) 앱 권한에서 500 을 내므로,
//  업무도우미가 문서함을 직접 훑어 파일 이름·경로·본문 글을 ms365_doc_index 에 저장하고 비서의 docs_search 가 그 표를 찾는다.
//  · 갱신: 관리자 [문서 색인 갱신] 버튼 + 아침·오후 일정 알림 크론 틱에 얹음(크론 2개 한도라 새로 안 늘림). 한 번에 시간 예산 안에서 바뀐 파일만.
//  · 본문은 앞 60,000자. 읽을 수 없는 형식(이미지·압축 등)은 이름·경로만(status skipped). AI 호출 없음 — 토큰 비용 0.
//  · 표가 없으면(마이그레이션 151 미적용) 검색은 null 을 돌려주고 호출부가 옛 방식(검색 끝점 → 폴더 훑기)으로 간다.
import { supabaseAdmin } from "./supabase";
import { getKv, setKv } from "./b2b-settings";
import { listChildren, type GraphItem } from "./msgraph";
import type { ResolvedSource } from "./ms365-docs";

const TABLE = "ms365_doc_index";
const KV_LAST = "ms365_index_last";
const TEXT_CAP = 60_000;
const WALK_FOLDERS = 400, WALK_ITEMS = 20_000;
const INDEXABLE = /\.(docx|pptx|xlsx|pdf|txt|md|csv|json|xml|html?|log|doc|xls|ppt|rtf|odt|ods|odp)$/i;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export type IndexRow = {
  ref: string; source: string; site_id: string; drive_id: string; name: string; path: string; url: string;
  modified: string; size_kb: number; status: "ok" | "skipped" | "error"; error: string; text: string; indexed_at: string;
};
export type IndexSummary = {
  at: string; scanned: number; indexed: number; skipped: number; errors: number; pending: number; deleted: number; partial: boolean;
  sites: string[]; note: string;
};

const missingTable = (msg: string) => /ms365_doc_index/.test(msg) && /(does not exist|schema cache|not find)/i.test(msg);

export async function lastIndexRun(): Promise<IndexSummary | null> {
  try { const raw = await getKv(KV_LAST); return raw ? (JSON.parse(raw) as IndexSummary) : null; } catch { return null; }
}

// 드라이브 전체 걷기(너비 우선) — 파일만 모은다. complete=false 면 상한·시간에 걸려 일부만 본 것.
async function walkDrive(driveId: string, deadline: number): Promise<{ files: GraphItem[]; complete: boolean }> {
  const files: GraphItem[] = [];
  const queue: string[] = [""];
  let folders = 0, scanned = 0;
  while (queue.length) {
    if (folders >= WALK_FOLDERS || scanned >= WALK_ITEMS || Date.now() > deadline) return { files, complete: false };
    const path = queue.shift() as string;
    folders++;
    const kids = await listChildren(driveId, path, 200);
    for (const it of kids) {
      scanned++;
      if (it.folder) { if ((it.folder.childCount ?? 1) > 0) queue.push(path ? `${path}/${it.name}` : it.name); }
      else files.push(it);
    }
  }
  return { files, complete: true };
}

const haystackOf = (name: string, path: string, text: string) => `${name} ${path}\n${text}`.toLowerCase().slice(0, TEXT_CAP + 1000);

// 색인 갱신 — sources·extract 는 ms365-docs 가 넘긴다(순환 import 를 피하려고).
export async function reindexDocs(p: {
  sources: ResolvedSource[];
  extract: (it: GraphItem, driveId: string) => Promise<string>;
  itemPath: (it: GraphItem) => string;
  docRef: (it: GraphItem, driveId: string) => string;
  budgetMs?: number;
}): Promise<IndexSummary> {
  const sb = supabaseAdmin();
  const t0 = Date.now();
  const deadline = t0 + (p.budgetMs ?? 40_000);
  const sum: IndexSummary = { at: new Date(t0).toISOString(), scanned: 0, indexed: 0, skipped: 0, errors: 0, pending: 0, deleted: 0, partial: false, sites: [], note: "" };
  const notes: string[] = [];
  for (const src of p.sources) {
    if (src.error) { notes.push(`${src.label}: ${src.error}`); continue; }
    sum.sites.push(src.site.id);
    for (const d of src.drives) {
      // 1) 지금 드라이브에 있는 파일
      let walk: { files: GraphItem[]; complete: boolean };
      try { walk = await walkDrive(d.id, deadline); }
      catch (e) { notes.push(`${src.label}/${d.name}: 목록 실패(${e instanceof Error ? e.message.slice(0, 100) : "오류"})`); sum.partial = true; continue; }
      if (!walk.complete) sum.partial = true;
      sum.scanned += walk.files.length;
      // 2) 이미 색인된 것
      const { data: known, error: ke } = await sb.from(TABLE).select("ref, modified, status").eq("drive_id", d.id);
      if (ke) { if (missingTable(ke.message)) throw new Error("문서 색인 표가 없습니다 — 마이그레이션 151_ms365_doc_index.sql 을 적용하세요."); throw new Error(`색인 읽기 실패: ${ke.message}`); }
      const knownMap = new Map((known || []).map((r) => [String(r.ref), { modified: String(r.modified || ""), status: String(r.status || "") }]));
      const seen = new Set<string>();
      const batch: IndexRow[] = [];
      const flush = async () => {
        if (!batch.length) return;
        const rows = batch.splice(0, batch.length).map((r) => ({ ...r, haystack: haystackOf(r.name, r.path, r.text), seen_at: sum.at }));
        const { error } = await sb.from(TABLE).upsert(rows, { onConflict: "ref" });
        if (error) throw new Error(`색인 저장 실패: ${error.message}`);
      };
      for (const it of walk.files) {
        const ref = p.docRef(it, d.id);
        seen.add(ref);
        const modified = it.lastModifiedDateTime || "";
        const prev = knownMap.get(ref);
        if (prev && prev.modified === modified && prev.status !== "error") continue; // 안 바뀜
        if (Date.now() > deadline) { sum.pending++; sum.partial = true; continue; }
        const base = { ref, source: src.label, site_id: src.site.id, drive_id: d.id, name: it.name || "", path: p.itemPath(it), url: it.webUrl || "", modified, size_kb: Math.round((it.size || 0) / 1024), indexed_at: new Date().toISOString() };
        if (!INDEXABLE.test(it.name || "") || (it.size || 0) > MAX_FILE_BYTES) {
          batch.push({ ...base, status: "skipped", error: (it.size || 0) > MAX_FILE_BYTES ? "25MB 초과" : "읽지 않는 형식", text: "" });
          sum.skipped++;
        } else {
          try { batch.push({ ...base, status: "ok", error: "", text: (await p.extract(it, d.id)).slice(0, TEXT_CAP) }); sum.indexed++; }
          catch (e) { batch.push({ ...base, status: "error", error: (e instanceof Error ? e.message : String(e)).slice(0, 200), text: "" }); sum.errors++; }
        }
        if (batch.length >= 10) await flush();
      }
      await flush();
      // 3) 사라진 파일 — 드라이브를 끝까지 봤을 때만 지운다(일부만 본 상태에서 지우면 멀쩡한 색인이 날아간다)
      if (walk.complete) {
        const gone = [...knownMap.keys()].filter((r) => !seen.has(r));
        for (let i = 0; i < gone.length; i += 200) {
          const { error } = await sb.from(TABLE).delete().in("ref", gone.slice(i, i + 200));
          if (error) { notes.push(`${src.label}/${d.name}: 정리 실패(${error.message.slice(0, 80)})`); break; }
          sum.deleted += Math.min(200, gone.length - i);
        }
      }
    }
  }
  sum.note = notes.join(" / ");
  try { await setKv(KV_LAST, JSON.stringify(sum)); } catch { /* 요약 저장 실패는 무시 */ }
  return sum;
}

export type IndexHit = { ref: string; source: string; site_id: string; name: string; path: string; url: string; modified: string; size_kb: number; status: string; snippet: string };

// 색인 검색 — 모든 검색어가 이름·경로·본문 어딘가에 있으면 적중. 표가 없으면 null(호출부가 옛 방식으로).
export async function searchIndex(p: { terms: string[]; siteIds: string[]; limit: number }): Promise<{ hits: IndexHit[]; indexedSites: Set<string>; at: string } | null> {
  const sb = supabaseAdmin();
  const terms = p.terms.map((t) => t.replace(/[%_\\]/g, "").trim()).filter(Boolean).slice(0, 6);
  if (!p.siteIds.length) return { hits: [], indexedSites: new Set(), at: "" };
  // 어느 사이트가 색인돼 있나(0건 적중과 '색인 없음'을 구분)
  const indexedSites = new Set<string>();
  for (const id of p.siteIds) {
    const { count, error } = await sb.from(TABLE).select("ref", { count: "exact", head: true }).eq("site_id", id);
    if (error) { if (missingTable(error.message)) return null; throw new Error(`색인 조회 실패: ${error.message}`); }
    if ((count || 0) > 0) indexedSites.add(id);
  }
  if (!indexedSites.size || !terms.length) return { hits: [], indexedSites, at: (await lastIndexRun())?.at || "" };
  let q = sb.from(TABLE).select("ref, source, site_id, name, path, url, modified, size_kb, status, text").in("site_id", [...indexedSites]);
  for (const t of terms) q = q.ilike("haystack", `%${t}%`);
  const { data, error } = await q.order("modified", { ascending: false }).limit(Math.min(p.limit, 50));
  if (error) throw new Error(`색인 검색 실패: ${error.message}`);
  const hits = (data || []).map((r) => {
    const text = String(r.text || "");
    const low = text.toLowerCase();
    let pos = -1;
    for (const t of terms) { const i = low.indexOf(t.toLowerCase()); if (i >= 0 && (pos < 0 || i < pos)) pos = i; }
    const snippet = pos >= 0 ? `…${text.slice(Math.max(0, pos - 70), pos + 110).replace(/\s+/g, " ")}…` : "";
    return { ref: String(r.ref), source: String(r.source), site_id: String(r.site_id), name: String(r.name), path: String(r.path), url: String(r.url || ""), modified: String(r.modified || "").slice(0, 10), size_kb: Number(r.size_kb || 0), status: String(r.status), snippet };
  });
  return { hits, indexedSites, at: (await lastIndexRun())?.at || "" };
}
