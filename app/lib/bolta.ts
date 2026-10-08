// 볼타(Bolta) 전자세금계산서 API — 서버 전용. 문서: https://docs.bolta.io (OpenAPI: /openapi.yaml)
//  인증 = HTTP Basic(사용자명 = API 키, 비밀번호 없음 → base64("KEY:")). 테스트 키(test_)와 라이브 키(live_)가 같은 서버를 쓰고
//  키 접두사로 모드가 갈린다 — test_ 는 국세청에 보내지 않고 포인트도 쓰지 않는다.
//  키는 env BOLTA_API_KEY 하나(테스트 → 라이브 전환 = 값만 바꿈). 없으면 발행 버튼이 잠긴다.
import { createHash } from "crypto";

const BASE = "https://xapi.bolta.io/v1";

export type BoltaMode = "test" | "live";
// keyFp = 키 지문(sha256 앞 12자) — 관리번호·접수 기록은 키마다 따로라, 다른 키로 발행한 문서는 조회 결과를 믿지 않는다
export function boltaConfig(): { key: string; mode: BoltaMode; keyFp: string } | null {
  const key = (process.env.BOLTA_API_KEY || "").trim();
  if (!key) return null;
  return { key, mode: key.startsWith("live_") ? "live" : "test", keyFp: createHash("sha256").update(key).digest("hex").slice(0, 12) };
}

export class BoltaError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = "BoltaError"; }
}
// 볼타가 확실히 받지 않은 오류인가 — 4xx(요청 시간 초과 408 제외)·키 없음만. 5xx·연결 끊김·응답 읽기 실패는
//  접수됐을 수도 있어(불확실) 실패로 두지 않고 관리번호로 다시 확인한다.
export const boltaRejected = (e: unknown) =>
  e instanceof BoltaError && (e.code === "NOT_CONFIGURED" || (e.status >= 400 && e.status < 500 && e.status !== 408));

type CallOpts = { body?: unknown; ref?: string; timeoutMs?: number };
async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, o: CallOpts = {}): Promise<{ status: number; data: T; headers: Headers }> {
  const cfg = boltaConfig();
  if (!cfg) throw new BoltaError(0, "NOT_CONFIGURED", "볼타 API 키(BOLTA_API_KEY)가 설정되지 않았습니다.");
  const headers: Record<string, string> = {
    Authorization: "Basic " + Buffer.from(`${cfg.key}:`).toString("base64"),
    Accept: "application/json",
  };
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  if (o.ref) headers["Bolta-Client-Reference-Id"] = o.ref;
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method, headers, cache: "no-store",
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
    });
  } catch (e) {
    // 응답을 못 받음 — 발행 요청이면 접수됐을 수도 있다(호출부가 관리번호로 상태를 다시 조회한다)
    throw new BoltaError(0, "NETWORK", `볼타 서버에 연결하지 못했습니다(${e instanceof Error ? e.message : String(e)}).`);
  }
  let text = "";
  try { text = await res.text(); } catch (e) {
    throw new BoltaError(res.ok ? 0 : res.status, "BODY_READ", `볼타 응답을 읽지 못했습니다(${e instanceof Error ? e.message : String(e)}).`);
  }
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok && res.status !== 202) {
    const d = (data ?? {}) as Record<string, unknown>;
    const err = (d.error ?? {}) as Record<string, unknown>;
    const code = String(d.code ?? err.code ?? d.errorCode ?? d.type ?? `HTTP_${res.status}`);
    const msg = String(d.message ?? err.message ?? d.detail ?? d.title ?? (typeof data === "string" && data ? data.slice(0, 300) : `HTTP ${res.status}`));
    throw new BoltaError(res.status, code, msg);
  }
  return { status: res.status, data: data as T, headers: res.headers };
}

// 정발행 — 접수만 된다(최종 결과는 웹훅 또는 조회). ref = 영구 1회용 관리번호.
export async function boltaIssue(body: unknown, ref: string): Promise<{ issuanceKey: string }> {
  const r = await call<{ issuanceKey?: string }>("POST", "/taxInvoices/issue", { body, ref, timeoutMs: 20_000 });
  if (!r.data?.issuanceKey) throw new BoltaError(r.status, "NO_ISSUANCE_KEY", "볼타가 접수 번호를 돌려주지 않았습니다.");
  return { issuanceKey: r.data.issuanceKey };
}

// 발행 완료된 계산서 — 국세청 승인번호(ntsTransactionId)는 여기서. 아직 처리 중이면 오류가 난다.
export type BoltaInvoice = { issuanceKey: string; ntsTransactionId?: string | null; issuedAt?: string | null };
export async function boltaGetInvoice(issuanceKey: string): Promise<BoltaInvoice> {
  return (await call<BoltaInvoice>("GET", `/taxInvoices/${encodeURIComponent(issuanceKey)}`, { timeoutMs: 8_000 })).data;
}

// 관리번호로 접수 여부 — 응답을 못 받았을 때 다시 보내지 말고 이걸 먼저(다시 보내면 관리번호 중복 400).
//  접수 기록이 없으면 볼타가 400(INVALID_REQUEST)·404 를 준다 → notFound. 그 밖의 오류는 그대로 던진다(모름).
export async function boltaIssueStatus(ref: string): Promise<{ issuanceKey?: string; notFound?: boolean }> {
  try {
    const d = (await call<{ issuanceKey?: string }>("GET", `/taxInvoices/issue/status?clientReferenceId=${encodeURIComponent(ref)}`, { timeoutMs: 8_000 })).data;
    return { issuanceKey: d?.issuanceKey || undefined };
  } catch (e) {
    if (e instanceof BoltaError && (e.status === 400 || e.status === 404)) return { notFound: true };
    throw e;
  }
}

// PDF — 첫 호출이 생성을 시작한다. 202 면 잠시 뒤 다시, 200 이면 5분짜리 다운로드 주소.
export async function boltaPdf(issuanceKey: string): Promise<{ ready: boolean; url?: string; retryAfter?: number; filename?: string }> {
  const r = await call<{ status?: string; downloadUrl?: string; filename?: string }>("GET", `/taxInvoices/${encodeURIComponent(issuanceKey)}/pdf`);
  if (r.status === 202 || r.data?.status === "PENDING" || !r.data?.downloadUrl) {
    return { ready: false, retryAfter: Number(r.headers.get("retry-after")) || 3 };
  }
  return { ready: true, url: r.data.downloadUrl, filename: r.data.filename };
}

// 작성일자 기준 발행 마감일(무료·한도 없음)
export async function boltaDueDate(date: string): Promise<string | null> {
  const r = await call<{ issueDueDate?: string }>("GET", `/taxInvoiceIssueDueDates?date=${encodeURIComponent(date)}`, { timeoutMs: 8_000 });
  return r.data?.issueDueDate ?? null;
}

// 발급자(자사) 등록·인증서 상태 — 발행 화면의 준비 상태 안내용
export type BoltaIssuer = { issuerId: string; identificationNumber: string; organizationName?: string; certificate?: { issuedAt?: string; expiresAt?: string } | null };
export async function boltaIssuers(): Promise<BoltaIssuer[]> {
  const r = await call<unknown>("GET", "/issuers", { timeoutMs: 8_000 });
  const d = r.data as { issuers?: BoltaIssuer[]; data?: BoltaIssuer[] } | BoltaIssuer[] | null;
  return Array.isArray(d) ? d : d?.issuers ?? d?.data ?? [];
}
