import { supabaseAdmin } from "./supabase";
import { getMeetingTerms } from "./meeting-terms";

// 리턴제로(RTZR) STT 연동 — 회의 녹음 파일을 화자 구분된 전사본으로 바꾼다 (회의 정리 화면의 '녹음 파일 변환').
//  · 인증: client_id/secret 으로 JWT 를 받아 쓴다(6시간). 자격증명은 b2b_settings 에 두고 코드/깃에 두지 않는다.
//  · 전사: POST /v1/transcribe (multipart) → id → GET /v1/transcribe/{id} 폴링. 완료 전까지 status=transcribing.
//  · 키워드 부스팅에는 회의 용어집(meeting_terms)을 그대로 넘긴다 — 정리 단계 용어집과 같은 목록이라 두 겹이 된다.
//  · 요금: 가입 시 600분 무료, 이후 시간당 1,000원(T1). 최소 집계 단위 10초.

const BASE = "https://openapi.vito.ai";

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

export const getRtzrClientId = () => getVal("rtzr_client_id");
export const setRtzrClientId = (s: string) => setVal("rtzr_client_id", s);
export const getRtzrClientSecret = () => getVal("rtzr_client_secret");
export const setRtzrClientSecret = (s: string) => setVal("rtzr_client_secret", s);

// 토큰 캐시 — 서버리스 인스턴스 안에서만 유효(재사용되면 아끼고, 아니면 새로 받는다). 만료 1분 전에 갱신.
let cached: { token: string; expiresAt: number } | null = null;

export async function getRtzrToken(): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return { ok: true, token: cached.token };

  const [id, secret] = await Promise.all([getRtzrClientId(), getRtzrClientSecret()]);
  if (!id || !secret) return { ok: false, error: "리턴제로 자격증명이 없습니다 (관리자 › 설정 › 음성 전사)." };

  try {
    const body = new URLSearchParams({ client_id: id, client_secret: secret });
    const r = await fetch(`${BASE}/v1/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = (await r.json().catch(() => null)) as { access_token?: string; expire_at?: number; message?: string } | null;
    if (!r.ok || !j?.access_token) {
      return { ok: false, error: `인증 실패(${r.status}) — ${j?.message || "client id/secret 을 확인하세요."}` };
    }
    // expire_at 은 초 단위 epoch. 값이 이상하면 6시간으로 본다.
    const exp = typeof j.expire_at === "number" && j.expire_at > 1_000_000_000 ? j.expire_at * 1000 : Date.now() + 6 * 3600_000;
    cached = { token: j.access_token, expiresAt: exp };
    return { ok: true, token: j.access_token };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "인증 중 오류" };
  }
}

export type RtzrConfig = {
  spkCount?: number | null;  // 참석 인원. 비우면 자동 예측(0)
  useKeywords?: boolean;     // 회의 용어집을 키워드 부스팅으로 넘길지
};

// 키워드 부스팅 목록 — 용어집에서 만든다. 너무 많이 넣으면 엉뚱한 곳에서 그 단어가 나오므로 상한을 둔다.
async function boostKeywords(): Promise<string[]> {
  const terms = await getMeetingTerms();
  return terms
    .map((t) => t.term.trim())
    .filter((t) => t.length >= 2 && t.length <= 20)
    .slice(0, 100);
}

// 전사 시작 — 성공하면 조회에 쓸 id 를 준다.
export async function startTranscribe(
  audio: { buf: ArrayBuffer; filename: string; contentType: string },
  cfg: RtzrConfig = {},
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const t = await getRtzrToken();
  if (!t.ok) return { ok: false, error: t.error };

  const config: Record<string, unknown> = {
    model_name: "sommers",
    language: "ko",
    use_diarization: true,
    use_paragraph_splitter: true,
    paragraph_splitter: { max: 50 },
  };
  // 참석 인원을 주면 그 수에 맞춰 가른다. 0/미지정이면 자동 예측.
  const n = Number(cfg.spkCount);
  if (Number.isFinite(n) && n >= 2 && n <= 20) config.diarization = { spk_count: Math.round(n) };

  if (cfg.useKeywords !== false) {
    const kw = await boostKeywords();
    if (kw.length) config.keywords = kw;
  }

  try {
    const fd = new FormData();
    fd.append("file", new Blob([audio.buf], { type: audio.contentType || "application/octet-stream" }), audio.filename);
    fd.append("config", JSON.stringify(config));

    const r = await fetch(`${BASE}/v1/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t.token}` }, // Content-Type 은 지정하지 않는다(경계 문자열을 fetch 가 붙인다)
      body: fd,
    });
    const j = (await r.json().catch(() => null)) as { id?: string; message?: string; code?: string } | null;
    if (!r.ok || !j?.id) {
      return { ok: false, error: `전사 요청 실패(${r.status}) — ${j?.message || j?.code || "알 수 없는 오류"}` };
    }
    return { ok: true, id: j.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "전사 요청 중 오류" };
  }
}

type Utterance = { start_at?: number; duration?: number; msg?: string; spk?: number };

export type TranscribeResult =
  | { ok: true; status: "transcribing" }
  | { ok: true; status: "completed"; text: string; speakers: number; seconds: number }
  | { ok: false; error: string };

export async function getTranscribe(id: string): Promise<TranscribeResult> {
  const t = await getRtzrToken();
  if (!t.ok) return { ok: false, error: t.error };

  try {
    const r = await fetch(`${BASE}/v1/transcribe/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${t.token}` },
      cache: "no-store",
    });
    const j = (await r.json().catch(() => null)) as
      | { status?: string; results?: { utterances?: Utterance[] }; message?: string }
      | null;
    if (!r.ok || !j) return { ok: false, error: `상태 조회 실패(${r.status}) — ${j?.message || "알 수 없는 오류"}` };

    if (j.status === "failed") return { ok: false, error: "전사에 실패했습니다. 파일 형식과 길이를 확인해주세요." };
    if (j.status !== "completed") return { ok: true, status: "transcribing" };

    const utts = Array.isArray(j.results?.utterances) ? j.results!.utterances! : [];
    const { text, speakers } = utterancesToText(utts);
    const last = utts[utts.length - 1];
    const seconds = last ? Math.round(((last.start_at || 0) + (last.duration || 0)) / 1000) : 0;
    return { ok: true, status: "completed", text, speakers, seconds };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "상태 조회 중 오류" };
  }
}

// 발화 목록을 회의 정리에 넣을 텍스트로 — 같은 사람이 이어서 말한 건 한 덩이로 합친다.
//  타임스탬프는 넣지 않는다(정리 단계에서 쓰지 않는데 길이만 늘려 요약 품질을 떨어뜨린다).
export function utterancesToText(utts: Utterance[]): { text: string; speakers: number } {
  const seen = new Set<number>();
  const blocks: { spk: number; parts: string[] }[] = [];

  for (const u of utts) {
    const msg = (u.msg || "").trim();
    if (!msg) continue;
    const spk = typeof u.spk === "number" ? u.spk : 0;
    seen.add(spk);
    const tail = blocks[blocks.length - 1];
    if (tail && tail.spk === spk) tail.parts.push(msg);
    else blocks.push({ spk, parts: [msg] });
  }

  const text = blocks.map((b) => `화자${b.spk + 1}: ${b.parts.join(" ")}`).join("\n\n");
  return { text, speakers: seen.size };
}

// 연결 점검 — 토큰이 발급되는지와 용어집이 몇 개 실리는지를 사람이 읽을 문장으로.
export async function testRtzrConnection(): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const t = await getRtzrToken();
  if (!t.ok) return { ok: false, lines: [`인증: 실패 — ${t.error}`] };
  lines.push("인증: OK — 토큰을 발급받았습니다.");
  const kw = await boostKeywords();
  lines.push(
    kw.length
      ? `키워드 부스팅: 용어집 ${kw.length}개가 전사에 함께 넘어갑니다.`
      : "키워드 부스팅: 용어집이 비어 있습니다 — 회의 정리 화면에서 사내 용어를 등록하면 인식률이 올라갑니다.",
  );
  return { ok: true, lines };
}
