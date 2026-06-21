import { supabaseAdmin } from "./supabase";

// UTM 빌더 설정(즐겨찾기 + 소스·매체 맵) — utm_settings(key-value) 테이블.
// 히스토리(utm_links)는 행 단위라 별도 라우트에서 직접 다룬다.

export type UrlPreset = { label: string; value: string };
export type SourceMediumMap = Record<string, string[]>;

const PRESETS_KEY = "url_presets";
const MAP_KEY = "source_medium_map";

// 클라이언트(utm-builder.html) 기본값과 동일하게 유지.
export const DEFAULT_URL_PRESETS: UrlPreset[] = [
  { label: "씨몬스터 카페24몰", value: "https://seamonster.co.kr" },
  { label: "네이버 스마트스토어", value: "https://smartstore.naver.com/seamonster" },
];

export const DEFAULT_SOURCE_MEDIUM_MAP: SourceMediumMap = {
  naver: ["cpc", "blog", "display", "shopping", "brand_search"],
  google: ["cpc", "display", "shopping", "discovery", "pmax"],
  kakao: ["cpc", "display", "bizboard", "kakao_moment"],
  instagram: ["social", "story", "reels", "collab"],
  facebook: ["social", "cpc", "display", "cpa"],
  youtube: ["video", "shorts", "display", "cpc"],
  tiktok: ["social", "video", "cpc", "spark_ads"],
  daum: ["cpc", "display", "blog"],
};

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
