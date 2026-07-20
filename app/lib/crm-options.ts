import { getKv, setKv } from "./b2b-settings";
import { DEFAULT_CRM_OPTIONS, sanitizeCrmOptions, type CrmOptions } from "./crm";

// CRM 선택지 영속화(서버 전용) — b2b_settings KV. 타입·기본값·정제는 crm.ts(클라이언트 공용).

const KEY = "crm_options";

export async function getCrmOptions(): Promise<CrmOptions> {
  const raw = await getKv(KEY);
  if (!raw) return DEFAULT_CRM_OPTIONS;
  try { return sanitizeCrmOptions(JSON.parse(raw)); } catch { return DEFAULT_CRM_OPTIONS; }
}

export async function saveCrmOptions(v: unknown): Promise<CrmOptions> {
  const clean = sanitizeCrmOptions(v);
  await setKv(KEY, JSON.stringify(clean));
  return clean;
}
