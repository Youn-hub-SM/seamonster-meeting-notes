// 회사 문서함 본문 색인(2026-10-27) — Graph 드라이브 검색(search(q=))이 사이트별 허용(Sites.Selected) 앱 권한에서 500 을 내므로,
//  업무도우미가 문서함을 직접 훑어 파일 이름·경로·본문 글을 ms365_doc_index 에 저장하고 비서의 docs_search 가 그 표를 찾는다.
//  · 목록: Graph delta(변경분) API — 처음엔 전체(200개씩 페이지), 그 뒤엔 바뀐 것만. 토큰은 kv 'ms365_delta:<드라이브>'.
//    (폴더를 하나씩 걷는 방식은 파일 1,500개에 45초를 다 써서 본문 읽기 차례가 오지 않았다 — 2026-10-27 실측)
//  · 본문: delta 로 받은 새·바뀐 파일은 status 'pending' 으로 먼저 저장하고, 남은 시간 예산 안에서 작은 파일부터 4개씩 읽는다.
//    못 읽은 것은 다음 실행(버튼 자동 반복·크론 틱)이 이어서. 본문은 앞 20,000자. 읽을 수 없는 형식·1MB 넘는 데이터 파일은 이름·경로만(skipped). AI 호출 없음.
//  · 검색은 name·path·text 에 ilike(대소문자 무시) — 소문자 복사본(haystack)은 153 에서 없앴다(저장량 절반).
//  · 표가 없으면(마이그레이션 151·152 미적용) 검색은 null 을 돌려주고 호출부가 옛 방식(검색 끝점 → 폴더 훑기)으로 간다.
import { supabaseAdmin } from "./supabase";
import { getKv, setKv } from "./b2b-settings";
import { graphJson, listChildren, type GraphItem } from "./msgraph";
import type { ResolvedSource } from "./ms365-docs";

const TABLE = "ms365_doc_index";
const KV_LAST = "ms365_index_last";
const KV_DELTA = "ms365_delta:";
const TEXT_CAP = 20_000;            // 본문 앞 2만 자(2026-10-27 용량 조정: 찾는 데는 앞부분이면 되고, 읽을 땐 docs_read 가 전문을 연다)
const WALK_FOLDERS = 400, WALK_ITEMS = 20_000;
const DELTA_PAGES = 150; // 200개씩 → 30,000 항목
const EXTRACT_PARALLEL = 4;
const PENDING_BATCH = 120;
const INDEXABLE = /\.(docx|pptx|xlsx|pdf|txt|md|csv|json|xml|html?|log|doc|xls|ppt|rtf|odt|ods|odp)$/i;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// 데이터 성격 파일(엑셀·CSV·JSON 등)은 1MB 를 넘으면 숫자 덩어리라 본문 검색 가치가 낮고 글자만 많다 → 이름·경로만
const DATA_EXT = /\.(xlsx|xls|csv|json|xml|log|ods)$/i;
const DATA_MAX_BYTES = 1024 * 1024;
const ITEM_SELECT = "$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference,deleted";

type DeltaItem = GraphItem & { deleted?: { state?: string } };
export type IndexRow = {
  ref: string; source: string; site_id: string; drive_id: string; name: string; path: string; url: string;
  modified: string; size_kb: number; status: "ok" | "skipped" | "error" | "pending"; error: string; text: string; indexed_at: string;
};
export type IndexSummary = {
  at: string; scanned: number; indexed: number; skipped: number; errors: number; pending: number; deleted: number; partial: boolean;
  sites: string[]; note: string;
};

const missingTable = (msg: string) => /ms365_doc_index/.test(msg) && /(does not exist|schema cache|not find)/i.test(msg);
const pendingUnsupported = (msg: string) => /status_check|check constraint/i.test(msg);

export async function lastIndexRun(): Promise<IndexSummary | null> {
  try { const raw = await getKv(KV_LAST); return raw ? (JSON.parse(raw) as IndexSummary) : null; } catch { return null; }
}

// 드라이브 루트 기준 경로(parentReference.path = '/drives/{id}/root:/폴더/하위')
function pathOf(it: GraphItem): string {
  const parent = (it.parentReference?.path || "").replace(/^\/drives\/[^/]+\/root:?/, "").replace(/^\/drive\/root:?/, "");
  let dir = parent.replace(/^\/+/, "");
  try { dir = decodeURIComponent(dir); } catch { /* 그대로 */ }
  return dir ? `${dir}/${it.name}` : it.name || "";
}

// ── 변경분(delta) — 처음엔 전체, 그 뒤엔 토큰 이후 바뀐 것만. 410(토큰 만료)이면 처음부터 다시. ──
async function fetchDelta(driveId: string, deadline: number): Promise<{ items: DeltaItem[]; complete: boolean; full: boolean }> {
  const key = `${KV_DELTA}${driveId}`;
  let token = "";
  try { token = (await getKv(key)) || ""; } catch { token = ""; }
  const start = token || `/drives/${driveId}/root/delta?${ITEM_SELECT}&$top=200`;
  const items: DeltaItem[] = [];
  let url: string | undefined = start;
  let full = !token;
  for (let page = 0; page < DELTA_PAGES && url; page++) {
    if (Date.now() > deadline) return { items, complete: false, full };
    let r: { value?: DeltaItem[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
    try { r = await graphJson(url); }
    catch (e) {
      // 토큰 만료·무효(410 resyncRequired) → 전체부터 다시
      if (token && /410|resync|invalidDeltaToken|SyncStateNotFound/i.test(e instanceof Error ? e.message : String(e))) {
        try { await setKv(key, ""); } catch { /* 무시 */ }
        return fetchDelta(driveId, deadline);
      }
      throw e;
    }
    items.push(...(r.value || []));
    if (r["@odata.deltaLink"]) { try { await setKv(key, r["@odata.deltaLink"]); } catch { /* 토큰 저장 실패 → 다음에 전체 다시 */ } return { items, complete: true, full }; }
    url = r["@odata.nextLink"];
  }
  return { items, complete: false, full };
}

// delta 가 안 되는 드라이브용 대체 — 폴더 걷기(너비 우선). complete=false 면 상한·시간에 걸려 일부만 본 것.
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
  const budget = p.budgetMs ?? 40_000;
  const deadline = t0 + budget;
  const listDeadline = t0 + Math.round(budget * 0.45); // 목록 받기엔 예산의 절반까지만 — 나머지는 본문 읽기
  const sum: IndexSummary = { at: new Date(t0).toISOString(), scanned: 0, indexed: 0, skipped: 0, errors: 0, pending: 0, deleted: 0, partial: false, sites: [], note: "" };
  const notes: string[] = [];

  const upsert = async (rows: (IndexRow & { seen_at?: string })[]) => {
    for (let i = 0; i < rows.length; i += 20) {
      const chunk = rows.slice(i, i + 20).map((r) => ({ ...r, seen_at: sum.at }));
      const { error } = await sb.from(TABLE).upsert(chunk, { onConflict: "ref" });
      if (error) {
        if (missingTable(error.message)) throw new Error("문서 색인 표가 없습니다 — 마이그레이션 151_ms365_doc_index.sql 을 적용하세요.");
        if (pendingUnsupported(error.message)) throw new Error("색인 표가 옛 버전입니다 — 마이그레이션 152_ms365_doc_index_pending.sql 을 적용하세요.");
        throw new Error(`색인 저장 실패: ${error.message}`);
      }
    }
  };

  // 1) 드라이브마다 목록(변경분) → 새·바뀐 파일은 pending 으로, 지워진 것은 삭제
  for (const src of p.sources) {
    if (src.error) { notes.push(`${src.label}: ${src.error}`); continue; }
    sum.sites.push(src.site.id);
    for (const d of src.drives) {
      if (Date.now() > listDeadline) { sum.partial = true; notes.push(`${src.label}/${d.name}: 목록은 다음 실행에`); continue; }
      const { data: known, error: ke } = await sb.from(TABLE).select("ref, modified, status").eq("drive_id", d.id);
      if (ke) { if (missingTable(ke.message)) throw new Error("문서 색인 표가 없습니다 — 마이그레이션 151_ms365_doc_index.sql 을 적용하세요."); throw new Error(`색인 읽기 실패: ${ke.message}`); }
      const knownMap = new Map((known || []).map((r) => [String(r.ref), { modified: String(r.modified || ""), status: String(r.status || "") }]));

      let files: GraphItem[] = [], deletedRefs: string[] = [], complete = false, full = false, viaDelta = true;
      try {
        const dl = await fetchDelta(d.id, listDeadline);
        complete = dl.complete; full = dl.full;
        for (const it of dl.items) {
          if (it.deleted) { deletedRefs.push(p.docRef(it, d.id)); continue; }
          if (it.folder || !it.id) continue;
          files.push(it);
        }
      } catch (e) {
        viaDelta = false;
        try { const w = await walkDrive(d.id, listDeadline); files = w.files; complete = w.complete; full = true; }
        catch (e2) { notes.push(`${src.label}/${d.name}: 목록 실패(${e2 instanceof Error ? e2.message.slice(0, 100) : "오류"})`); sum.partial = true; continue; }
        notes.push(`${src.label}/${d.name}: 변경분 API 실패(${e instanceof Error ? e.message.slice(0, 60) : "오류"}) → 폴더 걷기`);
      }
      if (!complete) sum.partial = true;
      sum.scanned += files.length;

      const rows: IndexRow[] = [];
      const seen = new Set<string>();
      for (const it of files) {
        const ref = p.docRef(it, d.id);
        seen.add(ref);
        const modified = it.lastModifiedDateTime || "";
        const prev = knownMap.get(ref);
        if (prev && prev.modified === modified && prev.status !== "error") continue; // 안 바뀜(pending 은 아래 2)에서 읽는다)
        rows.push({ ref, source: src.label, site_id: src.site.id, drive_id: d.id, name: it.name || "", path: viaDelta ? pathOf(it) : p.itemPath(it), url: it.webUrl || "", modified, size_kb: Math.round((it.size || 0) / 1024), status: "pending", error: "", text: "", indexed_at: new Date().toISOString() });
      }
      if (rows.length) await upsert(rows);
      // 지워진 파일 — delta 의 deleted 표시, 또는 전체 목록을 끝까지 봤을 때 없는 것
      if (full && complete) for (const r of knownMap.keys()) if (!seen.has(r)) deletedRefs.push(r);
      deletedRefs = [...new Set(deletedRefs)].filter((r) => knownMap.has(r));
      for (let i = 0; i < deletedRefs.length; i += 200) {
        const { error } = await sb.from(TABLE).delete().in("ref", deletedRefs.slice(i, i + 200));
        if (error) { notes.push(`${src.label}/${d.name}: 정리 실패(${error.message.slice(0, 80)})`); break; }
        sum.deleted += Math.min(200, deletedRefs.length - i);
      }
    }
  }

  // 2) pending 본문 읽기 — 작은 파일부터, 4개씩 병렬, 예산 끝까지
  const siteIds = sum.sites;
  while (siteIds.length && Date.now() < deadline) {
    const { data: pend, error: pe } = await sb.from(TABLE).select("ref, drive_id, name, size_kb").in("site_id", siteIds).eq("status", "pending").order("size_kb", { ascending: true }).limit(PENDING_BATCH);
    if (pe) { if (pendingUnsupported(pe.message)) throw new Error("색인 표가 옛 버전입니다 — 마이그레이션 152_ms365_doc_index_pending.sql 을 적용하세요."); throw new Error(`대기 목록 읽기 실패: ${pe.message}`); }
    const list = (pend || []) as { ref: string; drive_id: string; name: string; size_kb: number }[];
    if (!list.length) break;
    let progressed = 0;
    for (let i = 0; i < list.length && Date.now() < deadline; i += EXTRACT_PARALLEL) {
      const group = list.slice(i, i + EXTRACT_PARALLEL);
      const done = await Promise.all(group.map(async (r) => {
        const [driveId, itemId] = r.ref.split(":");
        const stub = { id: itemId, name: r.name, size: r.size_kb * 1024 } as GraphItem;
        const now = new Date().toISOString();
        const bytes = r.size_kb * 1024;
        const skipWhy = !INDEXABLE.test(r.name) ? "읽지 않는 형식" : bytes > MAX_FILE_BYTES ? "25MB 초과" : DATA_EXT.test(r.name) && bytes > DATA_MAX_BYTES ? "데이터 파일(1MB 초과, 이름만)" : "";
        if (skipWhy) { sum.skipped++; return { ref: r.ref, status: "skipped" as const, error: skipWhy, text: "", indexed_at: now }; }
        try { const text = (await p.extract(stub, driveId || r.drive_id)).slice(0, TEXT_CAP); sum.indexed++; return { ref: r.ref, status: "ok" as const, error: "", text, indexed_at: now }; }
        catch (e) { sum.errors++; return { ref: r.ref, status: "error" as const, error: (e instanceof Error ? e.message : String(e)).slice(0, 200), text: "", indexed_at: now }; }
      }));
      // 부분 갱신 — name·path 는 그대로 두고 상태·본문만
      for (const x of done) {
        const { error } = await sb.from(TABLE).update({ status: x.status, error: x.error, text: x.text, indexed_at: x.indexed_at }).eq("ref", x.ref);
        if (error) throw new Error(`색인 저장 실패: ${error.message}`);
      }
      progressed += done.length;
    }
    if (!progressed) break;
  }
  if (siteIds.length) {
    const { count } = await sb.from(TABLE).select("ref", { count: "exact", head: true }).in("site_id", siteIds).eq("status", "pending");
    sum.pending = count || 0;
    if (sum.pending) sum.partial = true;
  }
  sum.note = notes.join(" / ");
  try { await setKv(KV_LAST, JSON.stringify(sum)); } catch { /* 요약 저장 실패는 무시 */ }
  return sum;
}

export type IndexHit = { ref: string; source: string; site_id: string; name: string; path: string; url: string; modified: string; size_kb: number; status: string; snippet: string };

// 색인 검색 — 모든 검색어가 이름·경로·본문 어딘가에 있으면 적중. 표가 없으면 null(호출부가 옛 방식으로).
export async function searchIndex(p: { terms: string[]; siteIds: string[]; limit: number }): Promise<{ hits: IndexHit[]; indexedSites: Set<string>; at: string } | null> {
  const sb = supabaseAdmin();
  // ilike 패턴·PostgREST or() 문법에 끼는 글자는 뺀다(% _ \ , ( ) ")
  const terms = p.terms.map((t) => t.replace(/[%_\\,()"]/g, "").trim()).filter(Boolean).slice(0, 6);
  if (!p.siteIds.length) return { hits: [], indexedSites: new Set(), at: "" };
  // 어느 사이트가 색인돼 있나(0건 적중과 '색인 없음'을 구분) — 본문을 하나라도 읽은 사이트만
  const indexedSites = new Set<string>();
  for (const id of p.siteIds) {
    const { count, error } = await sb.from(TABLE).select("ref", { count: "exact", head: true }).eq("site_id", id).neq("status", "pending");
    if (error) { if (missingTable(error.message)) return null; throw new Error(`색인 조회 실패: ${error.message}`); }
    if ((count || 0) > 0) indexedSites.add(id);
  }
  if (!indexedSites.size || !terms.length) return { hits: [], indexedSites, at: (await lastIndexRun())?.at || "" };
  let q = sb.from(TABLE).select("ref, source, site_id, name, path, url, modified, size_kb, status, text").in("site_id", [...indexedSites]);
  for (const t of terms) q = q.or(`name.ilike.%${t}%,path.ilike.%${t}%,text.ilike.%${t}%`); // 검색어마다 (이름|경로|본문) — 여러 검색어는 AND
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
