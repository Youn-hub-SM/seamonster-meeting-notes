import { supabaseAdmin } from "./supabase";
import { DEFAULT_CONTENT_SLUGS, type CrmMediumExtra } from "./utm-rules";

// UTM 빌더 설정(즐겨찾기 + 소스·매체 맵) — utm_settings(key-value) 테이블.
// 히스토리(utm_links)는 행 단위라 별도 라우트에서 직접 다룬다.

export type { UrlPreset, SourceMediumMap } from "./utm-rules";
export { DEFAULT_URL_PRESETS, DEFAULT_SOURCE_MEDIUM_MAP } from "./utm-rules";
import { DEFAULT_URL_PRESETS, DEFAULT_SOURCE_MEDIUM_MAP, type UrlPreset, type SourceMediumMap } from "./utm-rules";

const PRESETS_KEY = "url_presets";
const MAP_KEY = "source_medium_map";
const MEDIA_KEY = "crm_media_extra"; // 직원이 추가한 CRM 발송 수단 [{value,label}]
const SLUGS_KEY = "content_slugs"; // CRM 버튼명 → utm_content 슬러그 사전(2026-11-06). 기본값은 utm-rules.ts

async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("utm_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  if (!data) return fallback;
  return (data.value as T) ?? fallback;
}

async function writeSetting(key: string, value: unknown): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("utm_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

export async function getUrlPresets(): Promise<UrlPreset[]> {
  return readSetting<UrlPreset[]>(PRESETS_KEY, DEFAULT_URL_PRESETS);
}

export async function setUrlPresets(presets: UrlPreset[]): Promise<void> {
  await writeSetting(PRESETS_KEY, presets);
}

export async function getSourceMediumMap(): Promise<SourceMediumMap> {
  return readSetting<SourceMediumMap>(MAP_KEY, DEFAULT_SOURCE_MEDIUM_MAP);
}

export async function setSourceMediumMap(map: SourceMediumMap): Promise<void> {
  await writeSetting(MAP_KEY, map);
}

export type ContentSlugs = Record<string, string>;

export async function getContentSlugs(): Promise<ContentSlugs> {
  const saved = await readSetting<ContentSlugs | null>(SLUGS_KEY, null);
  // 저장본이 있어도 기본 사전의 새 항목은 합친다(직원이 지운 키는 되살리지 않도록 저장본 우선)
  return saved && typeof saved === "object" ? { ...DEFAULT_CONTENT_SLUGS, ...saved } : { ...DEFAULT_CONTENT_SLUGS };
}

export async function setContentSlugs(dict: ContentSlugs): Promise<void> {
  await writeSetting(SLUGS_KEY, dict);
}

export async function getCrmMediaExtra(): Promise<CrmMediumExtra[]> {
  const v = await readSetting<CrmMediumExtra[]>(MEDIA_KEY, []);
  return Array.isArray(v) ? v.filter((m) => m && typeof m.value === "string" && m.value.trim()) : [];
}

export async function setCrmMediaExtra(list: CrmMediumExtra[]): Promise<void> {
  await writeSetting(MEDIA_KEY, list);
}
