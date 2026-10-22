// 인증번호 문자 → Teams 전달 (2026-10-22 대표: "알리고 인증 문자가 엄격해졌다 — 오면 팀즈 채팅방으로 자동으로").
//  입금 문자와 같은 경로다: 폰의 자동화 앱이 문자를 /api/sms/otp(또는 입금 웹훅)로 보내면 여기서 인증번호를 뽑아
//  Teams '인증번호 알림 채널'(없으면 B2B 알림 채널)에 카드로 올린다. 인증번호가 없는 문자는 아무것도 하지 않는다 —
//  폰이 문자를 전부 보내더라도 다른 문자가 Teams 로 새지 않는다.
//  예) "[Web발신]\n[알리고 문자] 인증번호 [603574]를 입력해 주세요."

import { getB2BTeamsConfig, sendTeamsWebhook } from "./b2b-teams";
import { getKv, setKv } from "./b2b-settings";

export type OtpParsed = { code: string; service: string };

// 인증번호: '인증번호 [603574]' · '인증번호: 603574' · '인증번호는 603574' · '[603574] 인증번호' 모두. 4~8자리 숫자.
//  '[Web발신]' 같은 머리말은 서비스명이 아니다.
export function parseOtpSms(text: string): OtpParsed | null {
  const t = (text || "").replace(/\r/g, "");
  if (!/인증\s*번호|인증\s*코드|verification code|OTP/i.test(t)) return null;
  const m = t.match(/(?:인증\s*번호|인증\s*코드|verification code|OTP)\s*(?:는|은|:|\]|\))?\s*\[?\s*(\d{4,8})\s*\]?/i)
    || t.match(/\[\s*(\d{4,8})\s*\]/)
    || t.match(/(?<!\d)(\d{4,8})(?!\d)\s*(?:를|을)?\s*(?:입력|인증)/);
  if (!m) return null;
  const heads = [...t.matchAll(/\[([^\]\n]{1,24})\]/g)].map((x) => x[1].trim()).filter((h) => !/^web\s*발신$/i.test(h) && !/^\d+$/.test(h));
  const service = (heads[0] || "").replace(/\s*(문자|알림|인증)$/, "").trim() || "인증";
  return { code: m[1], service };
}

const KV_LAST = "sms_otp_last";
const DEDUP_MS = 10 * 60_000;

export type OtpResult = { matched: boolean; parsed: OtpParsed | null; sent: boolean; duplicate?: boolean; reason?: string };

// 문자 한 통 처리. dry=true 면 파싱만.
export async function handleOtpSms(text: string, opts?: { dry?: boolean; receivedAt?: Date }): Promise<OtpResult> {
  const parsed = parseOtpSms(text);
  if (!parsed) return { matched: false, parsed: null, sent: false, reason: "인증번호를 찾지 못했습니다." };
  if (opts?.dry) return { matched: true, parsed, sent: false, reason: "dry" };

  // 같은 번호가 10분 안에 두 번 오면(폰이 재전송·두 경로로 보냄) 한 번만 올린다.
  try {
    const last = JSON.parse((await getKv(KV_LAST)) || "null") as { code?: string; at?: number } | null;
    if (last?.code === parsed.code && last.at && Date.now() - last.at < DEDUP_MS) return { matched: true, parsed, sent: false, duplicate: true, reason: "10분 안에 같은 번호를 이미 보냈습니다." };
  } catch { /* 기록 없음 */ }

  const cfg = await getB2BTeamsConfig();
  if (!cfg.enabled) return { matched: true, parsed, sent: false, reason: "Teams 발송이 꺼져 있습니다(관리자 › 설정 › 연결)." };
  const url = cfg.otpUrl || cfg.url;
  if (!url) return { matched: true, parsed, sent: false, reason: "Teams 채널 주소가 없습니다(관리자 › 설정 › 연결)." };

  const at = opts?.receivedAt ?? new Date();
  const k = new Date(at.getTime() + 9 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const when = `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())} ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}`;
  const body = (text || "").split("\n").map((l) => l.trim()).filter((l) => l && !/^\[web\s*발신\]$/i.test(l)).join("\n");
  const r = await sendTeamsWebhook(url, `${body}\n\n수신 ${when} · 대표 휴대폰 문자`, { title: `${parsed.service} 인증번호 ${parsed.code}` });
  if (!r.ok) return { matched: true, parsed, sent: false, reason: `Teams 발송 실패: ${r.error || r.status}` };
  try { await setKv(KV_LAST, JSON.stringify({ code: parsed.code, at: Date.now() })); } catch { /* 중복 방지 기록 실패는 무시 */ }
  return { matched: true, parsed, sent: true };
}
