import { supabaseAdmin } from "./supabase";
import type { Voc } from "./voc";

// flow.team(플로우) 연동 — 설정은 b2b_settings 키-값에 저장(코드/깃에 두지 않음).
//  API: POST {base}/user/posts/projects/{projectId}/tasks
//  헤더: Content-Type: application/json, x-flow-api-key: <키>
//  본문: title(≤200)·contents(≤10000)·status(request|progress|feedback|complete|hold)
//        priority(low|normal|high|urgent)·startDate/endDate(YYYYMMDD)·workers[{workerId}]·viewPermission(all|admin)

const DEFAULT_BASE = "https://api.flow.team";

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

export const getFlowApiKey = () => getVal("flow_api_key");
export const setFlowApiKey = (s: string) => setVal("flow_api_key", s);
export const getFlowProjectId = () => getVal("flow_project_id");
export const setFlowProjectId = (s: string) => setVal("flow_project_id", s);
export const getFlowBase = async () => (await getVal("flow_api_base")) || DEFAULT_BASE;
export const setFlowBase = (s: string) => setVal("flow_api_base", s);
export const getFlowDefaultPriority = async () => (await getVal("flow_default_priority")) || "normal";
export const setFlowDefaultPriority = (s: string) => setVal("flow_default_priority", s);
// 기본 담당자(workerId=이메일). 프로젝트 멤버여야 flow가 수락. 비우면 담당자 미지정.
export const getFlowDefaultWorker = () => getVal("flow_default_worker");
export const setFlowDefaultWorker = (s: string) => setVal("flow_default_worker", s);

// VOC 처리단계 → flow 업무 상태
export function vocStatusToFlow(status: string): "request" | "progress" | "complete" {
  if (status === "개선완료") return "complete";
  if (status === "응대·개선중") return "progress";
  return "request"; // 접수 등
}

const won = (n: number) => `${Math.round(Number(n) || 0).toLocaleString()}원`;
const ymd = (iso?: string | null) => (iso ? iso.replace(/-/g, "").slice(0, 8) : "");

// VOC → flow 업무 제목·본문(요청: 본문에 VOC 전체 내용). 길이 제한(200/10000) 준수.
export function buildFlowTaskFromVoc(v: Voc): { title: string; contents: string } {
  const who = v.customer || "고객";
  const what = v.product || "상품미상";
  const title = `[VOC/${v.category}] ${what} - ${who}`.slice(0, 200);

  const L: string[] = [];
  L.push(`■ VOC 요약`);
  L.push(`· 유형/상태: ${v.category} · ${v.status}`);
  L.push(`· 접수일: ${v.received_at}${v.purchase_date ? ` · 구매일: ${v.purchase_date}` : ""}`);
  L.push(`· 고객: ${who}${v.buyer_type ? ` (${v.buyer_type})` : ""}`);
  if (v.purchase_place || v.product) L.push(`· 구매처/상품: ${v.purchase_place || "-"} / ${v.product || "-"}`);
  if (v.production_date) L.push(`· 제품 생산일: ${v.production_date}`);
  L.push("");
  L.push(`■ 상세내용`); L.push(v.content || "-");
  if (v.cause) { L.push(""); L.push(`■ 원인`); L.push(v.cause); }
  if (v.resolution) { L.push(""); L.push(`■ 처리내용`); L.push(v.resolution); }
  if (v.improvement) { L.push(""); L.push(`■ 개선 필요사항`); L.push(v.improvement); }
  if (v.customer_note) { L.push(""); L.push(`■ 고객 특이사항`); L.push(v.customer_note); }
  L.push("");
  L.push(`■ 정산/처리`);
  L.push(`· 손해 귀책: ${v.fault} · 보상: ${v.comp_type}${v.comp_qty ? `×${v.comp_qty}` : ""} · 손해금액: ${won(v.loss_amount)}`);
  if (v.assignee) L.push(`· 담당자: ${v.assignee}`);
  L.push("");
  L.push(`— 씨몬스터 VOC #${v.id.slice(0, 8)} · 내부도구에서 등록`);

  return { title, contents: L.join("\n").slice(0, 10000) };
}

export type FlowTaskBody = {
  title: string; contents: string;
  status: string; priority?: string;
  startDate?: string; endDate?: string;
  workers?: { workerId: string }[];
  viewPermission?: string;
};

// flow 업무 생성 호출. 성공(2xx) 시 {ok:true, id?}. 실패 시 flow가 준 메시지 포함.
export async function createFlowTask(opts: { base: string; apiKey: string; projectId: string; body: FlowTaskBody }): Promise<{ ok: boolean; id: string | null; status: number; error?: string }> {
  const url = `${opts.base.replace(/\/$/, "")}/user/posts/projects/${encodeURIComponent(opts.projectId)}/tasks`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-flow-api-key": opts.apiKey },
      body: JSON.stringify(opts.body),
    });
  } catch (e) {
    return { ok: false, id: null, status: 0, error: `flow 연결 실패: ${(e as Error).message}` };
  }
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = (json as { message?: string; error?: string } | null)?.message
      || (json as { error?: string } | null)?.error || text.slice(0, 300) || `HTTP ${res.status}`;
    return { ok: false, id: null, status: res.status, error: `flow API ${res.status}: ${msg}` };
  }
  // 성공 — 반환 페이로드에서 식별자 추출(스키마가 불확실하므로 흔한 키들 시도)
  const j = json as Record<string, unknown> | null;
  const pick = (o: Record<string, unknown> | null | undefined, ...keys: string[]) => {
    for (const k of keys) { const val = o?.[k]; if (val != null && val !== "") return String(val); }
    return null;
  };
  const data = (j?.data as Record<string, unknown>) || (j?.result as Record<string, unknown>) || j;
  const id = pick(data, "postSrl", "post_srl", "id", "taskId", "srl", "postId");
  return { ok: true, id, status: res.status };
}
