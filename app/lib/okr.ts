import { supabaseAdmin } from "./supabase";
import { getAsanaPat, parseAsanaProjectGid, createAsanaTask, getAsanaTasksStatus, getAsanaProjectName, getAsanaSections } from "./voc-asana";

// OKR 1:1 체크인 — 회의 정리에서 각자 업로드한 요약·할 일을 아사나 두 곳으로 배포하고 기록한다.
//  · 개인 소통방(비공개 프로젝트, 대표+당사자): 비공개 요약 + personal 할 일
//  · 공통 'OKR 관리' 프로젝트(팀 공개): 공개 요약 + okr 할 일(제목에 [이름] 프리픽스)
//  설정은 b2b_settings KV: okr_project_gid(공통), okr_personal_map(JSON {사용자명: gid}),
//  okr_member_emails(JSON {사용자명: 아사나 계정 이메일} — 할 일의 담당자).
//  다음 회의 때 저장된 태스크 gid 로 완료 여부를 조회해 이행률을 계산한다(okr_checkins, 097).

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

export const getOkrProjectGid = () => getVal("okr_project_gid");
export const setOkrProjectGid = (s: string) => setVal("okr_project_gid", s);

// b2b_settings 에 JSON 으로 담긴 {사용자명: 값} 맵 — 개인방 gid 와 담당자 이메일이 같은 형태를 쓴다.
async function getMemberMap(key: string): Promise<Record<string, string>> {
  const raw = await getVal(key);
  if (!raw) return {};
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(j)) if (typeof v === "string" && v.trim()) out[k.trim()] = v.trim();
    return out;
  } catch { return {}; }
}

export const getOkrPersonalMap = () => getMemberMap("okr_personal_map");
export const setOkrPersonalMap = (m: Record<string, string>) => setVal("okr_personal_map", JSON.stringify(m));

// 사용자명 → 아사나 계정 이메일. 담당자가 비면 아사나는 '내 작업'에 띄우지도, 마감 알림을 보내지도 않는다.
export const getOkrMemberEmails = () => getMemberMap("okr_member_emails");
export const setOkrMemberEmails = (m: Record<string, string>) => setVal("okr_member_emails", JSON.stringify(m));

export type OkrTodoRecord = { text: string; scope: "personal" | "okr"; gid: string | null; project_gid: string };
export type OkrCheckin = {
  id: string; member: string; meeting_date: string; due_date: string | null;
  public_summary: string | null; private_summary: string | null;
  todos: OkrTodoRecord[]; created_at: string;
};

// 사용자 기준 준비 상태 — 화면이 버튼 노출을 결정하는 데 쓴다.
export async function okrReadiness(member: string): Promise<{ ready: boolean; hasPat: boolean; hasProject: boolean; hasPersonal: boolean }> {
  const [pat, project, map] = await Promise.all([getAsanaPat(), getOkrProjectGid(), getOkrPersonalMap()]);
  const hasPersonal = !!map[member];
  return { ready: !!pat && !!project && hasPersonal, hasPat: !!pat, hasProject: !!project, hasPersonal };
}

// 최근 체크인 + 아사나 완료 여부 — 이행률 표시용. 조회 실패한 태스크는 done=null(모름).
export async function latestCheckinWithStatus(member: string): Promise<
  { checkin: OkrCheckin; items: { text: string; scope: string; done: boolean | null }[]; doneCount: number; knownCount: number } | null
> {
  const { data, error } = await supabaseAdmin()
    .from("okr_checkins").select("*").eq("member", member)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error || !data) return null;
  const checkin = data as OkrCheckin;
  const todos = Array.isArray(checkin.todos) ? checkin.todos : [];
  const pat = await getAsanaPat();
  const gids = todos.map((t) => t.gid).filter((g): g is string => !!g);
  const status = pat && gids.length ? await getAsanaTasksStatus(pat, gids) : new Map<string, { completed: boolean }>();
  const items = todos.map((t) => ({
    text: t.text, scope: t.scope,
    done: t.gid && status.has(t.gid) ? status.get(t.gid)!.completed : null,
  }));
  const known = items.filter((i) => i.done !== null);
  return { checkin, items, doneCount: known.filter((i) => i.done).length, knownCount: known.length };
}

// 업로드 — 요약 2건 + 할 일들을 아사나에 만들고 체크인 행을 남긴다.
//  일부 태스크 생성이 실패해도 나머지는 진행하고(gid=null), 실패 수를 알려준다.
export async function uploadOkrCheckin(input: {
  member: string; meetingDate: string; dueDate: string | null;
  privateSummary: string; publicSummary: string;
  todos: { text: string; scope: "personal" | "okr" }[];
}): Promise<{ ok: boolean; error?: string; created: number; failed: number; checkinId?: string }> {
  const [pat, projectGid, map, emails] = await Promise.all([getAsanaPat(), getOkrProjectGid(), getOkrPersonalMap(), getOkrMemberEmails()]);
  if (!pat) return { ok: false, error: "아사나 PAT가 설정되지 않았습니다 (관리자 › 설정 › 아사나 연동).", created: 0, failed: 0 };
  if (!projectGid) return { ok: false, error: "OKR 관리 프로젝트가 설정되지 않았습니다 (관리자 › 설정 › 아사나 연동).", created: 0, failed: 0 };
  const personalGid = map[input.member];
  if (!personalGid) return { ok: false, error: `'${input.member}'의 개인 소통방 프로젝트가 연결되지 않았습니다 (관리자 › 설정 › 아사나 연동).`, created: 0, failed: 0 };

  let created = 0, failed = 0;
  let firstError: string | null = null; // 실패 원인 진단용 — 첫 오류를 그대로 사용자에게 보여준다
  const records: OkrTodoRecord[] = [];

  // OKR 프로젝트 섹션 배치(대표 확정, 2026-08-24): 공개 요약 → '회의록' 섹션, OKR 할 일 → 직원 이름 섹션.
  //  이름 부분일치 — 섹션이 없으면 기본 위치에 둔다(배치 실패가 업로드를 막지 않는다).
  const norm = (s: string) => s.replace(/\s/g, "");
  const okrSections = await getAsanaSections(pat, projectGid);
  const meetingSec = okrSections.find((s) => norm(s.name).includes("회의록")) || null;
  const memberSec = okrSections.find((s) => norm(s.name).includes(norm(input.member))) || null;

  // 요약 태스크 2건 — 완료 대상이 아니므로 기록에는 남기지 않는다(이행률 계산에서 제외)
  const sPriv = await createAsanaTask({ pat, projectGid: personalGid, name: `회의록 — ${input.meetingDate}`, notes: input.privateSummary });
  if (sPriv.ok) created++; else { failed++; firstError ??= sPriv.error || null; }
  const sPub = await createAsanaTask({ pat, projectGid, name: `회의록(공개) — ${input.member} · ${input.meetingDate}`, notes: input.publicSummary, sectionGid: meetingSec?.gid || null });
  if (sPub.ok) created++; else { failed++; firstError ??= sPub.error || null; }

  // 할 일은 당사자를 담당자로 지정한다 — 담당자가 비면 아사나가 '내 작업'에 띄우지 않아 마감 알림이 아무에게도 안 간다.
  //  이메일이 워크스페이스 멤버가 아니면 createAsanaTask 가 담당자 없이 재시도하므로 등록 자체는 살아남는다.
  const assigneeEmail = emails[input.member] || null;

  for (const t of input.todos) {
    const text = t.text.trim();
    if (!text) continue;
    const isOkr = t.scope === "okr";
    const target = isOkr ? projectGid : personalGid;
    const name = isOkr ? `[${input.member}] ${text}` : text;
    const r = await createAsanaTask({ pat, projectGid: target, name, notes: "", dueOn: input.dueDate, assigneeEmail, sectionGid: isOkr ? memberSec?.gid || null : null });
    if (r.ok) created++; else { failed++; firstError ??= r.error || null; }
    records.push({ text, scope: t.scope, gid: r.ok ? r.gid : null, project_gid: target });
  }

  // 전부 실패면 업로드 자체를 실패로 — 체크인 기록도 남기지 않는다(빈 gid 만 쌓임)
  if (created === 0) {
    return { ok: false, error: `아사나 생성이 모두 실패했습니다${firstError ? ` — ${firstError}` : ""}`, created, failed };
  }

  const { data, error } = await supabaseAdmin().from("okr_checkins").insert({
    member: input.member, meeting_date: input.meetingDate, due_date: input.dueDate,
    public_summary: input.publicSummary, private_summary: input.privateSummary,
    todos: records,
  }).select("id").maybeSingle();
  // 기록 실패(마이그레이션 097 미적용 등)여도 아사나 업로드 자체는 유효 — 경고로 전달
  const noAssignee = !assigneeEmail && records.length
    ? `'${input.member}'의 아사나 이메일이 없어 할 일이 담당자 없이 등록됐습니다 (관리자 › 설정 › 아사나 연동)`
    : null;
  const partial = [firstError ? `일부 실패(${failed}건) — ${firstError}` : null, noAssignee].filter(Boolean).join(" · ") || undefined;
  if (error) return { ok: true, error: [`체크인 기록 저장 실패: ${error.message}`, partial].filter(Boolean).join(" · "), created, failed };
  return { ok: true, created, failed, checkinId: data?.id, error: partial };
}

// OKR 연동 점검 — 공통 프로젝트와 매핑된 개인방 전부의 접근 가능 여부를 이름으로 확인.
export async function testOkrConnections(): Promise<{ ok: boolean; lines: string[] }> {
  const [pat, projectGid, map, emails] = await Promise.all([getAsanaPat(), getOkrProjectGid(), getOkrPersonalMap(), getOkrMemberEmails()]);
  if (!pat) return { ok: false, lines: ["아사나 PAT 미설정 — 위 카드에서 먼저 저장하세요."] };
  const lines: string[] = [];
  let allOk = true;
  const check = async (label: string, gid: string | null) => {
    if (!gid) { lines.push(`${label}: 미설정`); allOk = false; return; }
    const r = await getAsanaProjectName(pat, gid);
    if (r.ok) lines.push(`${label}: OK — '${r.name}'`);
    else { lines.push(`${label}: 실패 — ${r.error}`); allOk = false; }
  };
  await check("공통 OKR 프로젝트", projectGid);
  if (projectGid) {
    const secs = await getAsanaSections(pat, projectGid);
    if (secs.length) {
      const norm = (s: string) => s.replace(/\s/g, "");
      const hasMeeting = secs.some((s) => norm(s.name).includes("회의록"));
      lines.push(`공통 프로젝트 섹션: ${secs.map((s) => s.name).join(" · ")}${hasMeeting ? "" : " — '회의록' 섹션이 없어 공개 요약은 기본 위치에 들어갑니다"}`);
    }
  }
  for (const [user, gid] of Object.entries(map)) {
    await check(`개인 소통방(${user})`, gid);
    if (!emails[user]) { lines.push(`담당자 이메일(${user}): 미설정 — 할 일이 담당자 없이 등록됩니다`); allOk = false; }
  }
  if (!Object.keys(map).length) { lines.push("개인 소통방 매핑이 비어 있습니다."); allOk = false; }
  return { ok: allOk, lines };
}
