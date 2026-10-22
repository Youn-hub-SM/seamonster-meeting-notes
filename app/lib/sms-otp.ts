// 알리고 인증 문자 → Teams 전달 (2026-10-22 대표: "알리고 인증 문자가 엄격해졌다 — 오면 팀즈 채팅방으로 자동으로").
//  입금 문자와 같은 경로다: 폰의 자동화 앱이 문자를 /api/sms/otp(또는 입금 웹훅)로 보내면 여기서 인증번호를 뽑아
//  Teams '인증번호 알림 채널'(없으면 B2B 알림 채널)에 카드로 올린다.
//  대상은 '[알리고 문자]' 머리말이 있는 문자뿐이다(2026-10-22 대표: "알리고가 있는 것만, 다른 건 안 한다") —
//  다른 서비스의 인증 문자·일반 문자는 폰이 전부 보내더라도 Teams 로 새지 않는다.
//  예) "[Web발신]\n[알리고 문자] 인증번호 [603574]를 입력해 주세요."

import { getB2BTeamsConfig, sendTeamsWebhook } from "./b2b-teams";
import { getKv, setKv } from "./b2b-settings";

export type OtpParsed = { code: string; service: string };

// '[알리고 문자]' 머리말 + '인증번호 [603574]'(괄호·콜론 유무 허용, 4~8자리). 머리말이 없으면 인증번호가 있어도 null.
const ALIGO_RE = /\[\s*알리고(?:\s*문자)?\s*\]/;
export function parseOtpSms(text: string): OtpParsed | null {
  const t = (text || "").replace(/\r/g, "");
  if (!ALIGO_RE.test(t)) return null;
  const m = t.match(/인증\s*번호\s*(?:는|은|:)?\s*\[?\s*(\d{4,8})\s*\]?/);
  if (!m) return null;
  return { code: m[1], service: "알리고" };
}

const KV_LAST = "sms_otp_last";
const DEDUP_MS = 10 * 60_000;

export type OtpResult = { matched: boolean; parsed: OtpParsed | null; sent: boolean; duplicate?: boolean; reason?: string };

// 문자 한 통 처리. dry=true 면 파싱만.
export async function handleOtpSms(text: string, opts?: { dry?: boolean; receivedAt?: Date }): Promise<OtpResult> {
  const parsed = parseOtpSms(text);
  if (!parsed) return { matched: false, parsed: null, sent: false, reason: "알리고 인증 문자가 아닙니다." };
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
