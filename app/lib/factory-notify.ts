// 파도소리 → Swit 알림 (서버 전용).
//  Swit 수신 웹훅은 채널별 URL 에 {"text": "..."} JSON POST 하는 방식이다(공식 문서 기준).
//  URL 은 관리자가 /factory/settings 에서 붙여넣어 b2b_settings kv(factory_swit)에 저장 —
//  코드·환경변수에 URL 을 두지 않는다(도입 검토 중이라 채널이 바뀔 수 있음).
//
//  발송은 조용히 실패한다(알림이 입출고 기록을 막으면 안 된다). 단 응답을 보내기 전에
//  await 는 한다 — Vercel 함수는 응답 후 백그라운드 fetch 를 보장하지 않는다. 3초 타임아웃.

import { supabaseAdmin } from "./supabase";

const KV_KEY = "factory_swit";

export type FactorySwitConfig = { url: string; enabled: boolean };

export async function getFactorySwitConfig(): Promise<FactorySwitConfig> {
  try {
    const { data } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", KV_KEY).maybeSingle();
    const v = (data?.value ?? {}) as Partial<FactorySwitConfig>;
    return { url: typeof v.url === "string" ? v.url : "", enabled: !!v.enabled };
  } catch {
    return { url: "", enabled: false };
  }
}

export async function setFactorySwitConfig(cfg: FactorySwitConfig): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("b2b_settings")
    .upsert({ key: KV_KEY, value: cfg, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

// 웹훅 1건 발송. 반환값 = 성공 여부(테스트 발송에서만 씀 — 일반 알림은 결과를 무시한다).
export async function sendSwit(url: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, error: `Swit 응답 ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "발송 실패" };
  }
}

// 입출고 이벤트 알림 — 설정이 꺼져 있거나 URL 이 없으면 아무것도 안 한다.
export async function notifyFactory(text: string): Promise<void> {
  try {
    const cfg = await getFactorySwitConfig();
    if (!cfg.enabled || !cfg.url) return;
    await sendSwit(cfg.url, text);
  } catch {
    /* 알림 실패가 기록을 막지 않는다 */
  }
}

// 메시지 조립 헬퍼 — 모든 이벤트가 같은 꼴로 나가게 한 곳에서.
//  예: [파도소리] 출고 — 갈치두절 (150/200 · 국산 · 황) · 구평1 · 5B → 참바다 (현석)
export function factoryMsg(opts: {
  event: string;                 // 입고·출고·생산투입·이동·조정·취소·로트삭제
  label: string;                 // lotLabel() 결과
  warehouse?: string;
  qty?: number;
  unit?: string;
  dest?: string | null;
  who?: string | null;
  memo?: string | null;
}): string {
  const parts = [`[파도소리] ${opts.event} — ${opts.label}`];
  if (opts.warehouse) parts.push(opts.warehouse);
  if (opts.qty !== undefined) {
    const q = Number(opts.qty);
    parts.push(`${q > 0 && opts.event !== "입고" ? "+" : ""}${q.toLocaleString()}${opts.unit || "B"}`);
  }
  let line = parts.join(" · ");
  if (opts.dest) line += ` → ${opts.dest}`;
  if (opts.who) line += ` (${opts.who})`;
  if (opts.memo) line += `\n메모: ${opts.memo}`;
  return line;
}
