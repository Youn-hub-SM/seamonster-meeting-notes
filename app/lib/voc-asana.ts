import { supabaseAdmin } from "./supabase";

// 아사나(Asana) 연동 — VOC를 아사나 프로젝트의 업무(task)로 등록 (flow.team 대체, 2026-08-21).
//  설정은 b2b_settings 키-값에 저장(코드/깃에 두지 않음): PAT(개인 액세스 토큰)·프로젝트 gid·기본 담당자.
//  API: https://app.asana.com/api/1.0 — Authorization: Bearer <PAT>
//  본문은 {data:{...}} 래핑, 실패는 {errors:[{message}]} 형식.

const ASANA_BASE = "https://app.asana.com/api/1.0";

async function getVal(key: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", key).maybeSingle();
    if (error || !data) return null;
    const v = data.value as { v?: string } | string | null;
    const s = typeof v === "string" ? v : v?.v;
    return s && String(s).trim() ? String(s).trim() : null;
  } catch { return null; }
}
async function setVal(key: string, value: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("b2b_settings")
    .upsert({ key, value: { v: value.trim() }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

export const getAsanaPat = () => getVal("asana_pat");
export const setAsanaPat = (s: string) => setVal("asana_pat", s);
export const getAsanaProjectGid = () => getVal("asana_project_gid");
export const setAsanaProjectGid = (s: string) => setVal("asana_project_gid", s);
// 기본 담당자 — 아사나 워크스페이스 멤버의 이메일(비우면 미지정)
export const getAsanaDefaultAssignee = () => getVal("asana_default_assignee");
export const setAsanaDefaultAssignee = (s: string) => setVal("asana_default_assignee", s);

// 프로젝트 입력 정규화 — gid 숫자를 그대로 받거나, 아사나 프로젝트 URL에서 추출한다.
//  URL 꼴: https://app.asana.com/1/{workspace}/project/{gid}/... (신) · https://app.asana.com/0/{gid}/... (구)
export function parseAsanaProjectGid(input: string): string {
  const s = input.trim();
  if (!s) return "";
  if (/^\d{6,}$/.test(s)) return s;
  const byProject = s.match(/project\/(\d{6,})/);
  if (byProject) return byProject[1];
  const byLegacy = s.match(/\/0\/(\d{6,})(?:\/|$)/);
  if (byLegacy) return byLegacy[1];
  const anyGid = s.match(/(\d{12,})/); // gid 는 통상 12자리 이상 — 짧은 숫자(날짜 등) 오인 방지
  return anyGid ? anyGid[1] : "";
}

type AsanaResult = { ok: boolean; status: number; data: Record<string, unknown> | null; error?: string };

const ATTEMPT_TIMEOUT_MS = 12_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 아사나 호출(타임아웃 + 일시 오류 1회 재시도). 실패 시 사람이 읽을 메시지.
async function asanaFetch(pat: string, path: string, init?: { method?: string; body?: unknown }): Promise<AsanaResult> {
  let last: AsanaResult = { ok: false, status: 0, data: null, error: "아사나 응답 없음" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(`${ASANA_BASE}${path}`, {
        method: init?.method || "GET",
        headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json", Accept: "application/json" },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      const j = json as { data?: Record<string, unknown>; errors?: { message?: string }[] } | null;
      if (res.ok) return { ok: true, status: res.status, data: j?.data ?? null };
      const apiMsg = j?.errors?.[0]?.message || "";
      const friendly =
        res.status === 401 ? "아사나 토큰이 유효하지 않습니다(PAT 재발급 필요)" :
        res.status === 403 ? "아사나 접근 권한이 없습니다(프로젝트 멤버인지 확인)" :
        res.status === 404 ? "아사나 프로젝트를 찾을 수 없습니다(gid 확인)" :
        res.status === 429 ? "아사나 요청 한도 초과(잠시 후 재시도)" :
        `아사나 API ${res.status}`;
      last = { ok: false, status: res.status, data: null, error: apiMsg ? `${friendly}: ${apiMsg}` : friendly };
      if ((res.status === 429 || res.status >= 500) && attempt < 1) { await sleep(1200); continue; }
      return last;
    } catch (e) {
      clearTimeout(timer);
      const aborted = (e as Error).name === "AbortError";
      last = { ok: false, status: 0, data: null, error: aborted ? "아사나 서버 응답 시간 초과" : `아사나 연결 실패: ${(e as Error).message}` };
      if (attempt < 1) { await sleep(1200); continue; }
    }
  }
  return last;
}

// 업무 생성 — 성공 시 gid·permalink 반환.
export async function createAsanaTask(opts: {
  pat: string; projectGid: string;
  name: string; notes: string;
  completed?: boolean; assigneeEmail?: string | null;
}): Promise<{ ok: boolean; gid: string | null; url: string | null; error?: string }> {
  const data: Record<string, unknown> = {
    name: opts.name.slice(0, 1024),
    notes: opts.notes.slice(0, 60000),
    projects: [opts.projectGid],
  };
  if (opts.completed) data.completed = true;
  if (opts.assigneeEmail && opts.assigneeEmail.trim()) data.assignee = opts.assigneeEmail.trim();
  const r = await asanaFetch(opts.pat, "/tasks?opt_fields=gid,permalink_url", { method: "POST", body: { data } });
  if (!r.ok) {
    // 담당자 이메일이 워크스페이스 멤버가 아니면 400 — 담당자 없이 한 번 더 시도(등록 자체는 살린다)
    if (r.status === 400 && data.assignee) {
      delete data.assignee;
      const r2 = await asanaFetch(opts.pat, "/tasks?opt_fields=gid,permalink_url", { method: "POST", body: { data } });
      if (r2.ok) {
        const d2 = r2.data as { gid?: string; permalink_url?: string } | null;
        return { ok: true, gid: d2?.gid || null, url: d2?.permalink_url || null, error: "담당자 지정 실패(워크스페이스 멤버 아님) — 담당자 없이 등록됨" };
      }
    }
    return { ok: false, gid: null, url: null, error: r.error };
  }
  const d = r.data as { gid?: string; permalink_url?: string } | null;
  return { ok: true, gid: d?.gid || null, url: d?.permalink_url || null };
}

// 연결 테스트 — 토큰(내 정보)과 프로젝트 접근을 각각 확인해 이름으로 답한다.
export async function testAsanaConnection(pat: string, projectGid: string): Promise<{ ok: boolean; detail?: string; error?: string }> {
  const me = await asanaFetch(pat, "/users/me?opt_fields=name,email");
  if (!me.ok) return { ok: false, error: me.error };
  const meData = me.data as { name?: string; email?: string } | null;
  const proj = await asanaFetch(pat, `/projects/${encodeURIComponent(projectGid)}?opt_fields=name`);
  if (!proj.ok) return { ok: false, error: proj.error };
  const projData = proj.data as { name?: string } | null;
  return { ok: true, detail: `연결 OK — ${meData?.name || meData?.email || "사용자"} / 프로젝트 '${projData?.name || projectGid}'` };
}
