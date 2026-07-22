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
  // 첨부 사진 — flow 는 본문 첨부파일을 못 받으므로 공개 URL 링크로 넣는다(클릭하면 열림).
  const photos = (v.photos ?? []).filter((u) => typeof u === "string" && u.trim());
  if (photos.length) {
    L.push("");
    L.push(`■ 첨부 사진 (${photos.length})`);
    photos.forEach((u, i) => L.push(`· 사진${i + 1}: ${u.trim()}`));
  }
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

const ATTEMPT_TIMEOUT_MS = 12_000; // 한 번 시도가 이보다 길면 끊음(flow 지연 시 무한 대기 방지)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// flow API 는 종종 게이트웨이가 느려 502/503/504 를 준다.
//  · 502/503/429/네트워크오류 = 요청이 처리 전에 튕긴 것(안전하게 재시도)
//  · 504/408/타임아웃 = 처리됐을 수도 있어 재시도 시 중복 우려 → 딱 1번만
function retryPolicy(status: number): { retry: boolean; ambiguous: boolean } {
  if (status === 429 || status === 500 || status === 502 || status === 503) return { retry: true, ambiguous: false };
  if (status === 408 || status === 504 || status === 0) return { retry: true, ambiguous: true }; // 0 = 타임아웃/네트워크
  return { retry: false, ambiguous: false };
}

// flow 업무 생성 호출(타임아웃 + 유형별 재시도). 성공(2xx) 시 {ok:true, id?}. 실패 시 사람이 읽을 메시지.
export async function createFlowTask(opts: { base: string; apiKey: string; projectId: string; body: FlowTaskBody }): Promise<{ ok: boolean; id: string | null; status: number; error?: string }> {
  const url = `${opts.base.replace(/\/$/, "")}/user/posts/projects/${encodeURIComponent(opts.projectId)}/tasks`;

  let ambiguousUsed = false; // 504 류는 중복 우려로 딱 1회만 재시도
  let last: { status: number; error: string } = { status: 0, error: "flow 응답 없음" };

  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
    let res: Response | null = null;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-flow-api-key": opts.apiKey },
        body: JSON.stringify(opts.body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = (e as Error).name === "AbortError";
      last = { status: 0, error: aborted ? "flow 서버 응답 시간 초과" : `flow 연결 실패: ${(e as Error).message}` };
      const pol = retryPolicy(0);
      if (pol.retry && !(pol.ambiguous && ambiguousUsed) && attempt < 2) { if (pol.ambiguous) ambiguousUsed = true; await sleep(1000 * (attempt + 1)); continue; }
      break;
    }
    clearTimeout(timer);

    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON(예: nginx 504 HTML) */ }

    if (res.ok) {
      const j = json as Record<string, unknown> | null;
      const pick = (o: Record<string, unknown> | null | undefined, ...keys: string[]) => {
        for (const k of keys) { const val = o?.[k]; if (val != null && val !== "") return String(val); }
        return null;
      };
      const data = (j?.data as Record<string, unknown>) || (j?.result as Record<string, unknown>) || j;
      const id = pick(data, "postSrl", "post_srl", "id", "taskId", "srl", "postId");
      return { ok: true, id, status: res.status };
    }

    // 실패 — HTML(504 페이지 등)은 사용자에게 그대로 보이지 않게 상태코드만 요약
    const isHtml = /<html|<head|Gateway Time-out/i.test(text);
    const apiMsg = (json as { message?: string; error?: string } | null)?.message || (json as { error?: string } | null)?.error;
    const friendly = res.status === 504 ? "flow 서버 응답 지연(504)" : res.status === 502 || res.status === 503 ? `flow 서버 일시 오류(${res.status})` : `flow API ${res.status}`;
    last = { status: res.status, error: `${friendly}${apiMsg ? `: ${apiMsg}` : isHtml ? "" : text ? `: ${text.slice(0, 200)}` : ""}` };

    const pol = retryPolicy(res.status);
    if (pol.retry && !(pol.ambiguous && ambiguousUsed) && attempt < 2) { if (pol.ambiguous) ambiguousUsed = true; await sleep(1000 * (attempt + 1)); continue; }
    break;
  }

  // 재시도까지 실패 — 이미 등록됐을 가능성 안내(중복 방지)
  const tail = (last.status === 504 || last.status === 0) ? " — 이미 flow에 등록됐을 수 있으니 flow에서 확인 후, 없으면 다시 시도하세요." : " — 잠시 후 다시 시도하세요.";
  return { ok: false, id: null, status: last.status, error: last.error + tail };
}
