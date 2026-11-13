// 솔라피(SOLAPI) 발송 내역 API — 스마트스토어 알림톡·브랜드메시지 발송 건수를 API 로 모은다(2026-10-26, docs/crm-dashboard-plan.md).
//  인증: HMAC-SHA256(공식 SDK 와 같은 방식) — Authorization: HMAC-SHA256 apiKey=…, date=ISO8601, salt=32자, signature=hmac(secret, date+salt)
//  자격 = env SOLAPI_API_KEY · SOLAPI_API_SECRET (솔라피 콘솔 > 개발/연동 > API Key 관리). 외부 SDK 없이 fetch.
//  끝점: GET https://api.solapi.com/messages/v4/list?startDate&endDate&dateType=CREATED&limit=500&startKey  (응답 messageList 는 messageId 키의 객체)
import { createHmac, randomBytes } from "node:crypto";

const BASE = "https://api.solapi.com";
const TIMEOUT_MS = 20_000;

export function isSolapiConfigured(): boolean {
  return !!(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET);
}

function authHeader(): string {
  const apiKey = (process.env.SOLAPI_API_KEY || "").trim();
  const secret = (process.env.SOLAPI_API_SECRET || "").trim();
  if (!apiKey || !secret) throw new Error("솔라피 자격(SOLAPI_API_KEY·SOLAPI_API_SECRET)이 설정되지 않았습니다.");
  const alphabet = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = randomBytes(32);
  let salt = "";
  for (let i = 0; i < 32; i++) salt += alphabet[bytes[i] % alphabet.length];
  const date = new Date().toISOString();
  const signature = createHmac("sha256", secret).update(date + salt).digest("hex");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

export type SolapiMessage = {
  messageId: string; groupId?: string; type?: string | null; status?: string; statusCode?: string | null; reason?: string | null;
  dateCreated?: string; dateUpdated?: string; dateReceived?: string | null; to?: string; from?: string | null;
  kakaoOptions?: { pfId?: string; templateId?: string } | null;
};

// 기간의 발송 메시지 전부(페이징). 문자·주소는 쓰지 않고 집계에 필요한 것만 남긴다.
export async function fetchSolapiMessages(p: { since: string; until: string; max?: number }): Promise<Pick<SolapiMessage, "messageId" | "type" | "status" | "statusCode" | "dateCreated" | "kakaoOptions">[]> {
  const out: Pick<SolapiMessage, "messageId" | "type" | "status" | "statusCode" | "dateCreated" | "kakaoOptions">[] = [];
  const max = p.max ?? 20_000;
  let startKey: string | undefined;
  for (let page = 0; page < 200 && out.length < max; page++) {
    const q = new URLSearchParams({ startDate: `${p.since}T00:00:00+09:00`, endDate: `${p.until}T23:59:59+09:00`, dateType: "CREATED", limit: "500" });
    if (startKey) q.set("startKey", startKey);
    const res = await fetch(`${BASE}/messages/v4/list?${q}`, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    const j = (await res.json().catch(() => ({}))) as { messageList?: Record<string, SolapiMessage>; nextKey?: string; errorCode?: string; errorMessage?: string };
    if (!res.ok) throw new Error(`솔라피 ${res.status}: ${j.errorMessage || j.errorCode || "조회 실패"}`);
    for (const m of Object.values(j.messageList || {})) out.push({ messageId: m.messageId, type: m.type, status: m.status, statusCode: m.statusCode, dateCreated: m.dateCreated, kakaoOptions: m.kakaoOptions ? { templateId: m.kakaoOptions.templateId } : null });
    if (!j.nextKey) break;
    startKey = j.nextKey;
  }
  return out;
}

// 카카오 템플릿 목록(ID → 이름) — 발송 내역엔 템플릿 ID 만 있어 화면에 이름을 붙이려고 같이 가져온다. GET /kakao/v2/templates (startKey 페이징)
export type SolapiTemplate = { templateId: string; name: string; status?: string; channelId?: string };
export async function fetchSolapiTemplates(): Promise<SolapiTemplate[]> {
  const out: SolapiTemplate[] = [];
  let startKey: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ limit: "500" });
    if (startKey) q.set("startKey", startKey);
    const res = await fetch(`${BASE}/kakao/v2/templates?${q}`, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    const j = (await res.json().catch(() => ({}))) as { templateList?: { templateId?: string; name?: string; status?: string; channelId?: string; pfId?: string }[]; nextKey?: string; errorMessage?: string; errorCode?: string };
    if (!res.ok) throw new Error(`솔라피 템플릿 ${res.status}: ${j.errorMessage || j.errorCode || "조회 실패"}`);
    for (const t of j.templateList || []) if (t.templateId) out.push({ templateId: t.templateId, name: t.name || "", status: t.status, channelId: t.channelId || t.pfId });
    if (!j.nextKey) break;
    startKey = j.nextKey;
  }
  return out;
}

export type SolapiDayStat = { date: string; type: string; templateId: string; sent: number; failed: number };

// KST 날짜 × 메시지 종류(ATA 알림톡·CTA/CTI 친구톡·브랜드메시지·SMS 등) × 템플릿 ID 집계. 성공 = statusCode '4000'(발송 성공)
export function aggregateSolapi(msgs: Pick<SolapiMessage, "type" | "status" | "statusCode" | "dateCreated" | "kakaoOptions">[]): SolapiDayStat[] {
  const map = new Map<string, SolapiDayStat>();
  for (const m of msgs) {
    if (!m.dateCreated) continue;
    const t = Date.parse(m.dateCreated);
    if (Number.isNaN(t)) continue;
    const date = new Date(t + 9 * 3600_000).toISOString().slice(0, 10);
    const type = String(m.type || "ETC");
    const templateId = m.kakaoOptions?.templateId || "";
    const k = `${date}|${type}|${templateId}`;
    const row = map.get(k) || { date, type, templateId, sent: 0, failed: 0 };
    const ok = m.statusCode === "4000" || (m.status === "COMPLETE" && !m.statusCode);
    if (ok) row.sent++; else if (m.status === "COMPLETE") row.failed++;
    map.set(k, row);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
}

// ── 문자 보내기(2026-11-14, 신청자 문자 app/lib/form-sms.ts) ──
//  POST /messages/v4/send-many/detail  body { messages: [{ to, from, text }], allowDuplicates: false }
//  종류(SMS 90바이트 / LMS 2,000바이트)는 솔라피가 문구 길이로 고른다(autoTypeDetect 기본값).
//  응답: groupInfo.groupId + failedMessageList[{ to, statusCode, statusMessage }] — 여기에 없는 번호는 접수된 것.
//  ★ 두 가지 실패를 갈라 던진다 — 부르는 쪽이 '다시 보내도 되는가'를 정할 수 있게.
//    SolapiRejected = 솔라피가 요청을 거절함(HTTP 4xx·5xx 응답을 받음) → 한 통도 접수되지 않았다. 다시 보내도 된다.
//    그 밖의 오류(시간 초과·연결 끊김) = 접수됐는지 모른다 → 다시 보내면 두 번 갈 수 있다.
export class SolapiRejected extends Error {}
export type SolapiSendResult = { groupId: string | null; failed: { to: string; code: string; message: string }[] };
export async function sendSolapiSms(p: { from: string; text: string; to: string[] }): Promise<SolapiSendResult> {
  const body = { messages: p.to.map((to) => ({ to, from: p.from, text: p.text })), allowDuplicates: false };
  const res = await fetch(`${BASE}/messages/v4/send-many/detail`, {
    method: "POST", headers: { Authorization: authHeader(), "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store",
  });
  const j = (await res.json().catch(() => ({}))) as {
    groupInfo?: { groupId?: string; _id?: string }; failedMessageList?: { to?: string; statusCode?: string; statusMessage?: string }[];
    errorCode?: string; errorMessage?: string;
  };
  if (!res.ok) throw new SolapiRejected(`솔라피 ${res.status}: ${j.errorMessage || j.errorCode || "발송 요청이 거절됐습니다"}`);
  return {
    groupId: j.groupInfo?.groupId || j.groupInfo?._id || null,
    failed: (j.failedMessageList || []).map((f) => ({ to: String(f.to || "").replace(/\D/g, ""), code: String(f.statusCode || ""), message: String(f.statusMessage || "접수 실패") })),
  };
}
