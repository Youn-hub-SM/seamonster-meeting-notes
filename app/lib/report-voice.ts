// 종합 리포트 '4. 고객의 소리'(주간만, 2026-10-12 대표 요청) — 사실 모으기 + 코드 표.
//  (a) 스마트스토어 고객문의(1:1)·상품문의(Q&A) — 137 channel_inquiries, 문의 등록 시각(KST)이 그 주 안인 것의 질문·답변
//  (b) 업무도우미 VOC — voc, 접수일이 그 주 안이고 설문이 아닌 것
//  숫자(건수·미답변·답변 시간·유형별·귀책별·손해 합계·전주)는 코드가 계산하고, AI 는 원문을 뜻으로 줄여 쓴다(앞 N자 자르기 아님).
//  개인정보: 고객 이름·아이디·주문번호(137 에 없음)와 voc 의 customer·customer_note·photos·created_by·assignee 는 읽지 않는다.
//   자유 글은 연락처·이메일·주민번호 모양·긴 숫자를 가린 뒤 보낸다(maskPii). 저장되는 facts 에는 집계만(voiceForDb), 원문은 AI 입력에만.
//  토큰: AI 에는 문의·VOC 각 40건, 글마다 글자 상한 — 줄였으면 capped 에 적어 리포트가 밝힌다.
//  실패: 137 미적용이면 문의 쪽만 ok=false('수집 전(137 미적용)'), VOC 는 그대로. 읽기 실패는 0 이 아니라 ok=false + note.
//  수집 범위: 시작(첫 수집 − 8일)과 끝(종류별 마지막 수집 성공 — /api/claims/report 가 남기는 heartbeat, 없으면 대장 마지막 저장)을
//   둘 다 본다 — 폴러가 멈춘 기간·한 종류만 실패한 기간의 0건을 '없음'으로 보고하지 않게.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages } from "./sales-paging";
import { VOICE_BLOCK } from "./report-sections";

type Range = { since: string; until: string };

const NAVER = "스마트스토어";                  // channel_inquiries.channel(/api/claims/report 의 채널 이름) — 쿠팡은 범위 밖
const KINDS = ["고객문의", "상품문의"] as const;
// 건수·글자 상한(토큰 비용) — 글마다 상한 + 부분마다 글자 총량(JSON 길이, 한글 1자 ≈ 1토큰 안팎)
const CAP = { inquiries: 40, voc: 40, q: 500, a: 400, title: 80, content: 500, field: 200, inqBudget: 14_000, vocBudget: 10_000 } as const;
export const VOICE_SLOW_H = 24;                 // 답변이 이보다 오래 걸리면 '늦은 답변'
// 폴러가 매번 보내는 문의 범위 = 'KST 8일 전 0시 ~ 지금'(수집일 D 기준 D-8 ~ D, 오늘 포함 9일 — 고객문의·상품문의 같음).
//  scripts/claims-poll.mjs INQUIRY_LOG_BACK_DAYS 와 같은 값이어야 한다. 수집 시작 전 기간 판정용.
const POLL_BACK_DAYS = 8;
// 대장 마지막 저장이 그 주 끝(진행 중인 주면 지금)보다 이 시간 넘게 이르면 '수집 멈춤 의심' 경고(heartbeat 가 없을 때만 — 구 폴러).
//  대장은 새 문의·답변이 들어올 때만 저장되므로(/api/claims/report) 조용한 기간과 구별하려고 여유를 둔다.
const STALE_H = 48;
// 종류별 마지막 수집 성공(heartbeat) — b2b_settings kv. app/api/claims/report/route.ts INQUIRY_HB_KEY 와 같은 키.
//  폴러는 10분마다 돌므로 그 주 끝(진행 중이면 지금)보다 HB_STALE_H 넘게 이르면 그 뒤 문의는 빠졌을 수 있다.
const HB_KEY = "inquiry_log_heartbeat";
const HB_STALE_H = 3;

// ── 사실 형태 ──
export type VoiceInquiryItem = { kind: string; d: string; product?: string; cat?: string; title?: string; q: string; a?: string; answered: boolean; h?: number };
export type VoiceVocItem = { d: string; cat: string; product?: string; place?: string; buyer?: string; content: string; resolution?: string; cause?: string; improvement?: string; fault: string; comp?: string; qty?: number; loss?: number };
export type VoiceNaver = {
  ok: boolean;
  note?: string;                                // 실패·생략 사유
  coverage?: string;                            // 수집 시작이 기간 중간이거나 수집이 멈춘 것으로 보여 일부만 잡혔을 수 있는 경우
  total?: number;
  prev_total?: number | null;                   // null = 전주 비교 불가(수집 전·집계 실패)
  by_kind?: { kind: string; count: number; prev: number | null }[];
  by_category?: { category: string; count: number }[];   // 고객문의 분류(네이버 category)
  top_products?: { product: string; count: number }[];   // 문의 2건 이상 상품 — 반복 질문 후보
  unanswered?: number;                          // 지금(마지막 수집) 기준 미답변
  answered?: number;
  avg_answer_h?: number | null;                 // 답변된 문의의 등록→답변 시간 평균·최장(시간)
  max_answer_h?: number | null;
  slow?: number;                                // 답변이 VOICE_SLOW_H 시간 넘게 걸린 수
  prev_avg_answer_h?: number | null;
  synced_at?: string | null;                    // 문의 마지막 수집 성공(heartbeat) 또는 대장 마지막 저장(구 폴러) 시각(KST M/D HH:mm) — 그 주가 비어도 나온다
  synced_by?: "heartbeat" | "updated_at";       // synced_at 의 근거
  items?: VoiceInquiryItem[];                   // AI 전용(저장 안 함)
  capped?: string;
};
export type VoiceVoc = {
  ok: boolean;
  note?: string;
  total?: number;
  prev_total?: number | null;
  by_category?: { category: string; count: number; prev: number | null; loss: number }[];
  by_fault?: { fault: string; count: number; loss: number }[];
  by_comp?: { comp: string; count: number }[];  // 보상유형(없음 제외)
  rising?: { category: string; count: number; prev: number }[]; // 전주보다 늘어난 유형(2건 이상)
  loss_total?: number;
  prev_loss_total?: number | null;
  items?: VoiceVocItem[];                       // AI 전용(저장 안 함)
  capped?: string;
};
export type VoiceFacts = { basis: string; naver: VoiceNaver; voc: VoiceVoc };

// ── 공용 ──
const shift = (ymd: string, days: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const kstIso = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString();
const kstDate = (iso: string) => kstIso(iso).slice(0, 10);
const kstAt = (iso: string) => { const k = kstIso(iso); return `${md(k.slice(0, 10))} ${k.slice(11, 16)}`; };
const startOf = (ymd: string) => `${ymd}T00:00:00+09:00`;
const r1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown) => Number(v) || 0;
const errMsg = (e: unknown) => String((e as { message?: string } | null)?.message ?? e).slice(0, 140);
const missing137 = (e: unknown) => {
  const m = errMsg(e), code = (e as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205" || (/channel_inquiries/i.test(m) && /does not exist|schema cache|could not find/i.test(m));
};
const countBy = <T,>(xs: T[], key: (x: T) => string) => { const m = new Map<string, number>(); for (const x of xs) { const k = key(x); m.set(k, (m.get(k) || 0) + 1); } return m; };

// 개인정보 가림 — 주민번호 모양·이메일·연락처·긴 숫자(주문번호·계좌·카드 등, 날짜 YYYY-MM-DD 는 그대로).
//  이름·주소는 글에서 가려낼 수 없어 프롬프트가 옮겨 쓰지 않게 막는다.
//  연락처는 구분자 앞뒤 공백('010 - 1234 - 5678')까지, 번호는 공백·하이픈으로 나눈 묶음(카드 '1234 5678 9012 3456'·계좌)도
//  숫자 합 10자리 이상이면 가린다(날짜 'YYYY-MM-DD' 로 시작하는 묶음은 그대로).
export function maskPii(s: string): string {
  return s
    .replace(/\d{6}\s?-\s?[1-8]\d{6}/g, "[주민번호]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[이메일]")
    .replace(/(^|[^\d])((?:\+82\s?[-.]?\s?|0)\d{1,2}\s?[-.)]?\s?\d{3,4}\s?[-.]?\s?\d{4})(?!\d)/g, "$1[연락처]")
    .replace(/\d+(?:(?:[ \t]?-[ \t]?|[ \t])\d+){2,}/g, (m) => (/^(19|20)\d{2}[ \t]?-[ \t]?\d{1,2}[ \t]?-[ \t]?\d{1,2}(?!\d)/.test(m) || m.replace(/\D/g, "").length < 10 ? m : "[번호]"))
    .replace(/\d[\d-]*\d/g, (m) => (/^\d{4}-\d{1,2}-\d{1,2}$/.test(m) || m.replace(/\D/g, "").length < 8 ? m : "[번호]"));
}
// 글 정리 — 태그·공백 정리 → 가림 → 글자 상한(가린 뒤에 잘라 번호 조각이 남지 않게). 잘렸으면 cut.n 을 센다.
function clean(s: string | null | undefined, max: number, cut: { n: number }): string | undefined {
  if (!s) return undefined;
  let t = maskPii(String(s).replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim());
  if (!t) return undefined;
  if (t.length > max) { cut.n++; t = `${t.slice(0, max)}…`; }
  return t;
}
// 답변 앞뒤 인사말(안녕하세요 … / 감사합니다 …)은 뜻이 없어 뺀다(토큰 절약) — 빼고 남는 게 없으면 원문 그대로
const answerBody = (s: string | null | undefined) => {
  const t = (s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
  const body = t
    .replace(/^(안녕하세요|안녕하십니까)[\s,.!~^]*(고객님[\s,.!~^]*)?/, "")
    .replace(/^(씨몬스터|seamonster)\S{0,4}\s*입니다[\s,.!~^]*/i, "")
    .replace(/[\s,]*(감사합니다|고맙습니다)[\s.!~^]*$/, "").trim();
  return body || t;
};
const short = (s: string | null | undefined, max: number) => { const t = (s || "").replace(/\s+/g, " ").trim(); return t ? maskPii(t).slice(0, max) : undefined; };
// 우선순위 순서(xs)대로 최대 maxN 건, 글자 총량(JSON 길이) budget 안에서 고른다 — 넘치는 첫 건에서 멈춰 우선순위를 지킨다.
function pickWithin<R, I>(xs: R[], maxN: number, budget: number, toItem: (r: R, cut: { n: number }) => I): { chosen: { r: R; it: I }[]; cutN: number } {
  const chosen: { r: R; it: I }[] = [];
  let used = 0, cutN = 0;
  for (const r of xs) {
    if (chosen.length >= maxN) break;
    const cut = { n: 0 };
    const it = toItem(r, cut);
    const len = JSON.stringify(it).length;
    if (chosen.length && used + len > budget) break;
    used += len; cutN += cut.n; chosen.push({ r, it });
  }
  return { chosen, cutN };
}

// ── (a) 스마트스토어 문의 ──
type InqRow = { kind: string; product_name: string | null; category: string | null; title: string | null; question: string | null; answer: string | null; answered: boolean | null; asked_at: string | null; answered_at: string | null };
type InqPrev = { kind: string; answered: boolean | null; asked_at: string | null; answered_at: string | null };
const delayH = (r: { answered: boolean | null; asked_at: string | null; answered_at: string | null }): number | null => {
  if (!r.answered || !r.asked_at || !r.answered_at) return null;
  const h = (Date.parse(r.answered_at) - Date.parse(r.asked_at)) / 3600e3;
  return Number.isFinite(h) && h >= 0 ? h : null;
};
const avgOf = (xs: number[]) => (xs.length ? r1(xs.reduce((s, x) => s + x, 0) / xs.length) : null);

async function naverVoice(sb: SupabaseClient, cur: Range, prev: Range): Promise<VoiceNaver> {
  const T = "channel_inquiries";
  const settle = <X,>(p: Promise<X>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
  // 문의 등록 시각이 그 주(KST 월 0시 ~ 다음 월 0시) 안인 것 — 1000행씩 끝까지(S4)
  const read = <R,>(cols: string, r: Range, label: string) => settle(fetchAllPages<R>((lo, hi) => sb.from(T).select(cols).eq("channel", NAVER)
    .gte("asked_at", startOf(r.since)).lt("asked_at", startOf(shift(r.until, 1)))
    .order("asked_at", { ascending: true }).order("id", { ascending: true }).range(lo, hi), { cap: 5000, label }));
  const [curR, prevR, firstC, firstA, lastU, hbR] = await Promise.all([
    read<InqRow>("id, kind, product_name, category, title, question, answer, answered, asked_at, answered_at", cur, "스마트스토어 문의"),
    read<InqPrev>("id, kind, answered, asked_at, answered_at", prev, "스마트스토어 문의(전주)"),
    sb.from(T).select("created_at").eq("channel", NAVER).order("created_at", { ascending: true }).limit(1),
    sb.from(T).select("asked_at").eq("channel", NAVER).not("asked_at", "is", null).order("asked_at", { ascending: true }).limit(1),
    sb.from(T).select("updated_at").eq("channel", NAVER).order("updated_at", { ascending: false }).limit(1),
    sb.from("b2b_settings").select("value").eq("key", HB_KEY).maybeSingle(),
  ]);
  if (!curR.ok) return { ok: false, note: missing137(curR.e) ? "수집 전(137 미적용)" : `스마트스토어 문의 조회 실패: ${errMsg(curR.e)}` };
  const rangeErr = firstC.error || firstA.error || lastU.error || hbR.error;
  if (rangeErr) return { ok: false, note: `스마트스토어 문의 수집 범위 확인 실패: ${errMsg(rangeErr)}` };

  // 수집 시작 — 첫 수집 시각 − 8일과 가장 이른 문의 중 이른 쪽부터. 그 전 기간의 0건은 '없음'이 아니라 '수집 전'이다.
  const fc = (firstC.data as { created_at: string }[] | null)?.[0]?.created_at;
  const fa = (firstA.data as { asked_at: string }[] | null)?.[0]?.asked_at;
  if (!fc) return { ok: false, note: "수집된 문의 없음(수집 시작 전)" };
  const covStart = [shift(kstDate(fc), -POLL_BACK_DAYS), fa ? kstDate(fa) : "9999-12-31"].sort()[0];
  if (covStart > cur.until) return { ok: false, note: `이 기간은 문의 수집 전(수집 시작 ${md(covStart)})` };

  // 수집 끝 — 종류별 마지막 수집 성공(heartbeat). 그 주가 시작되기 전에 멈춘 종류는 그 주 0건을 확인할 수 없어 집계에서 빼고(전부면 ok=false),
  //  그 주 끝(진행 중이면 지금)보다 HB_STALE_H 넘게 이르면 '그 뒤 빠졌을 수 있음'. heartbeat 가 아직 없으면(구 폴러) 대장 마지막 저장으로
  //  근사 — 새 문의·답변이 들어올 때만 쓰여 조용한 기간과는 STALE_H 여유로만 구별한다.
  const weekStartMs = Date.parse(startOf(cur.since));
  const refMs = Math.min(Date.now(), Date.parse(startOf(shift(cur.until, 1))));
  const hbRaw = (hbR.data as { value?: { v?: string } | string | null } | null)?.value;
  let hb: Record<string, string> | null = null;
  try {
    const j = JSON.parse(typeof hbRaw === "string" ? hbRaw : hbRaw?.v || "null");
    if (j && typeof j === "object" && j[NAVER] && typeof j[NAVER] === "object") hb = j[NAVER];
  } catch { hb = null; }
  const coverageParts = [covStart > cur.since ? `문의 수집이 ${md(covStart)}부터라 그 전 문의는 빠졌습니다` : ""];
  let liveKinds: readonly string[] = KINDS;
  let lastAt: string;
  let syncedBy: "heartbeat" | "updated_at";
  if (hb) {
    const hbm = hb;
    const at = (k: string): number | null => { const ms = Date.parse(hbm[k] || ""); return Number.isFinite(ms) ? ms : null; };
    const label = (k: string) => { const ms = at(k); return `${k} ${ms != null ? kstAt(new Date(ms).toISOString()) : "기록 없음"}`; };
    const dead = KINDS.filter((k) => (at(k) ?? 0) < weekStartMs);
    const stale = KINDS.filter((k) => !dead.includes(k) && refMs - (at(k) ?? 0) > HB_STALE_H * 3600e3);
    const latest = Math.max(...KINDS.map((k) => at(k) ?? 0));
    lastAt = latest > 0 ? kstAt(new Date(latest).toISOString()) : "-";
    syncedBy = "heartbeat";
    if (dead.length === KINDS.length) {
      return { ok: false, note: `문의 수집 마지막 성공이 이 기간 전이라 확인할 수 없습니다(${dead.map(label).join(" · ")} — 중계 서버 폴러 확인)`, synced_at: lastAt, synced_by: syncedBy };
    }
    liveKinds = KINDS.filter((k) => !dead.includes(k));
    if (dead.length) coverageParts.push(`${dead.join("·")}는 마지막 수집 성공이 이 기간 전이라(${dead.map(label).join(" · ")}) 집계에서 뺐습니다`);
    if (stale.length) coverageParts.push(`마지막 수집 성공 ${stale.map(label).join(" · ")} — 그 뒤 문의는 빠졌을 수 있음`);
  } else {
    const lu = (lastU.data as { updated_at: string | null }[] | null)?.[0]?.updated_at || fc;
    const luMs = Date.parse(lu);
    lastAt = kstAt(lu);
    syncedBy = "updated_at";
    if (luMs < weekStartMs) {
      return { ok: false, note: `문의 대장 마지막 저장이 ${lastAt}라 이 기간 문의를 확인할 수 없습니다(수집 중단 의심 — 중계 서버 폴러 확인)`, synced_at: lastAt, synced_by: syncedBy };
    }
    if (refMs - luMs > STALE_H * 3600e3) coverageParts.push(`문의 대장에 ${lastAt} 이후 새로 저장된 문의·답변이 없습니다 — 수집이 멈췄다면 그 뒤 문의는 빠졌을 수 있음`);
  }
  const coverage = coverageParts.filter(Boolean).join(" · ") || undefined;
  const live = (r: { kind: string }) => liveKinds.includes(r.kind) || !(KINDS as readonly string[]).includes(r.kind);
  const prevRows = prevR.ok && covStart <= prev.since ? prevR.v.filter(live) : null; // 전주 전체가 수집 범위 안일 때만 비교(수집되는 종류끼리)

  const rows = curR.v.filter(live);
  const kinds = [...liveKinds, ...[...new Set(rows.map((r) => r.kind))].filter((k) => !(KINDS as readonly string[]).includes(k))];
  const by_kind = kinds.map((k) => ({ kind: k, count: rows.filter((r) => r.kind === k).length, prev: prevRows ? prevRows.filter((r) => r.kind === k).length : null }));
  const cat = countBy(rows.filter((r) => r.kind === "고객문의"), (r) => (r.category || "").trim() || "미분류");
  const prod = countBy(rows.filter((r) => (r.product_name || "").trim()), (r) => r.product_name!.replace(/\s+/g, " ").trim());
  const delays = rows.map(delayH).filter((h): h is number => h != null);
  const prevDelays = prevRows ? prevRows.map(delayH).filter((h): h is number => h != null) : [];

  // AI 에 보낼 원문 — 미답변 → 늦은 답변 → 나머지(등록 순) 순으로 최대 40건·글자 총량 안에서, 상품별로 모아(비슷한 문의를 묶기 쉽게)
  const rank = (r: InqRow) => (!r.answered ? 0 : (delayH(r) ?? 0) > VOICE_SLOW_H ? 1 : 2);
  const toItem = (r: InqRow, cut: { n: number }): VoiceInquiryItem => {
    const h = delayH(r);
    return {
      kind: r.kind, d: r.asked_at ? md(kstDate(r.asked_at)) : "-",
      product: short(r.product_name, 60), cat: short(r.category, 30), title: clean(r.title, CAP.title, cut),
      q: clean(r.question, CAP.q, cut) || "(본문 없음)", a: clean(answerBody(r.answer), CAP.a, cut), answered: !!r.answered,
      ...(h != null ? { h: r1(h) } : {}),
    };
  };
  const { chosen, cutN } = pickWithin([...rows].sort((x, y) => rank(x) - rank(y)), CAP.inquiries, CAP.inqBudget, toItem);
  const items = chosen
    .sort((x, y) => x.r.kind.localeCompare(y.r.kind) || (x.r.product_name || "").localeCompare(y.r.product_name || "") || (x.r.asked_at || "").localeCompare(y.r.asked_at || ""))
    .map((x) => x.it);
  const capped = [
    rows.length > items.length ? `문의 ${rows.length}건 중 ${items.length}건만 원문 전달(미답변·늦은 답변 먼저, 건수 ${CAP.inquiries}건·글자 총량 상한)` : "",
    cutN ? `글자 상한(질문 ${CAP.q}자·답변 ${CAP.a}자)으로 ${cutN}개 글을 줄임` : "",
  ].filter(Boolean).join(" · ");
  return {
    ok: true, ...(coverage ? { coverage } : {}),
    ...(!prevR.ok ? { note: "전주 문의 집계 실패 — 전주 비교 생략" } : !prevRows ? { note: "전주는 문의 수집 전 — 전주 비교 생략" } : {}),
    total: rows.length, prev_total: prevRows ? prevRows.length : null, by_kind,
    by_category: [...cat].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    top_products: [...prod].filter(([, c]) => c >= 2).map(([product, count]) => ({ product: product.slice(0, 60), count })).sort((a, b) => b.count - a.count).slice(0, 5),
    unanswered: rows.filter((r) => !r.answered).length, answered: rows.filter((r) => r.answered).length,
    avg_answer_h: avgOf(delays), max_answer_h: delays.length ? r1(Math.max(...delays)) : null,
    slow: delays.filter((h) => h > VOICE_SLOW_H).length, prev_avg_answer_h: prevRows ? avgOf(prevDelays) : null,
    synced_at: lastAt, synced_by: syncedBy,
    items, ...(capped ? { capped } : {}),
  };
}

// ── (b) 업무도우미 VOC ──
type VocRow = { id: string; received_at: string; product: string | null; category: string | null; purchase_place: string | null; buyer_type: string | null; content: string | null; resolution: string | null; cause: string | null; improvement: string | null; fault: string | null; comp_type: string | null; comp_qty: number | null; loss_amount: number | string | null };
type VocPrev = { category: string | null; fault: string | null; loss_amount: number | string | null };
const VOC_COLS = "id, received_at, product, category, purchase_place, buyer_type, content, resolution, cause, improvement, fault, comp_type, comp_qty, loss_amount";

async function vocVoice(sb: SupabaseClient, cur: Range, prev: Range): Promise<VoiceVoc> {
  const read = <R,>(cols: string, r: Range, label: string) => fetchAllPages<R>((lo, hi) => sb.from("voc").select(cols)
    .gte("received_at", r.since).lte("received_at", r.until).neq("source", "설문")
    .order("received_at", { ascending: true }).order("id", { ascending: true }).range(lo, hi), { cap: 5000, label });
  const [curR, prevR] = await Promise.all([
    read<VocRow>(VOC_COLS, cur, "VOC").then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })),
    read<VocPrev>("id, category, fault, loss_amount", prev, "VOC(전주)").then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })),
  ]);
  if (!curR.ok) return { ok: false, note: `VOC 조회 실패: ${errMsg(curR.e)}` };
  const rows = curR.v, prevRows = prevR.ok ? prevR.v : null;
  const catOf = (r: { category: string | null }) => (r.category || "").trim() || "기타";
  const faultOf = (r: { fault: string | null }) => (r.fault || "").trim() || "미분류";
  const lossOf = (r: { loss_amount: number | string | null }) => Math.round(num(r.loss_amount));
  const sumLoss = (xs: { loss_amount: number | string | null }[]) => xs.reduce((s, r) => s + lossOf(r), 0);

  const cats = [...countBy(rows, catOf)].map(([category, count]) => ({
    category, count, prev: prevRows ? prevRows.filter((r) => catOf(r) === category).length : null, loss: sumLoss(rows.filter((r) => catOf(r) === category)),
  })).sort((a, b) => b.count - a.count || b.loss - a.loss);
  const faults = [...countBy(rows, faultOf)].map(([fault, count]) => ({ fault, count, loss: sumLoss(rows.filter((r) => faultOf(r) === fault)) })).sort((a, b) => b.count - a.count || b.loss - a.loss);
  const comps = [...countBy(rows.filter((r) => r.comp_type && r.comp_type !== "없음"), (r) => r.comp_type!)].map(([comp, count]) => ({ comp, count })).sort((a, b) => b.count - a.count);
  const rising = cats.filter((c) => c.prev != null && c.count >= 2 && c.count > c.prev).map((c) => ({ category: c.category, count: c.count, prev: c.prev as number }));

  // AI 에 보낼 원문 — 유형마다 돌아가며 골라(많은 유형만 차지하지 않게) 최대 40건·글자 총량 안에서, 유형·접수일 순으로
  const queues = cats.map((c) => rows.filter((r) => catOf(r) === c.category));
  const order: VocRow[] = [];
  for (let k = 0; queues.some((q) => k < q.length); k++) for (const q of queues) if (k < q.length) order.push(q[k]);
  const toItem = (r: VocRow, cut: { n: number }): VoiceVocItem => {
    const comp = r.comp_type && r.comp_type !== "없음" ? r.comp_type : undefined, loss = lossOf(r);
    return {
      d: md(r.received_at), cat: catOf(r), product: short(r.product, 60), place: short(r.purchase_place, 30), buyer: r.buyer_type || undefined,
      content: clean(r.content, CAP.content, cut) || "(내용 없음)", resolution: clean(r.resolution, CAP.field, cut), cause: clean(r.cause, CAP.field, cut),
      improvement: clean(r.improvement, CAP.field, cut), fault: faultOf(r), ...(comp ? { comp, qty: num(r.comp_qty) || 1 } : {}), ...(loss > 0 ? { loss } : {}),
    };
  };
  const { chosen, cutN } = pickWithin(order, CAP.voc, CAP.vocBudget, toItem);
  const catRank = new Map(cats.map((c, i) => [c.category, i]));
  const items = chosen.sort((x, y) => (catRank.get(catOf(x.r)) ?? 0) - (catRank.get(catOf(y.r)) ?? 0) || x.r.received_at.localeCompare(y.r.received_at)).map((x) => x.it);
  const capped = [
    rows.length > items.length ? `VOC ${rows.length}건 중 ${items.length}건만 원문 전달(유형별로 고르게, 건수 ${CAP.voc}건·글자 총량 상한)` : "",
    cutN ? `글자 상한(내용 ${CAP.content}자·처리/원인/개선 ${CAP.field}자)으로 ${cutN}개 글을 줄임` : "",
  ].filter(Boolean).join(" · ");
  return {
    ok: true, ...(prevRows ? {} : { note: "전주 VOC 집계 실패 — 전주 비교 생략" }),
    total: rows.length, prev_total: prevRows ? prevRows.length : null,
    by_category: cats, by_fault: faults, by_comp: comps, rising,
    loss_total: sumLoss(rows), prev_loss_total: prevRows ? sumLoss(prevRows) : null,
    items, ...(capped ? { capped } : {}),
  };
}

const BASIS = `문의 = 스마트스토어 고객문의(1:1)·상품문의(Q&A), 문의 등록 시각(KST) 기준 · 미답변·답변 시간은 마지막 수집 기준(답변 ${VOICE_SLOW_H}시간 넘으면 늦은 답변) · VOC = 업무도우미 등록 VOC(접수일 기준, 설문 제외)`;

// 기간(주) 고객의 소리 — 두 부분은 따로 실패한다(한쪽이 실패해도 다른 쪽은 그대로)
export async function collectVoiceFacts(sb: SupabaseClient, range: Range, prevRange: Range): Promise<VoiceFacts> {
  const fail = (label: string) => (e: unknown) => ({ ok: false, note: `${label} 집계 실패: ${errMsg(e)}` });
  const [naver, voc] = await Promise.all([
    naverVoice(sb, range, prevRange).catch(fail("스마트스토어 문의")) as Promise<VoiceNaver>,
    vocVoice(sb, range, prevRange).catch(fail("VOC")) as Promise<VoiceVoc>,
  ]);
  return { basis: BASIS, naver, voc };
}

// 저장용(리포트 행 facts) — 집계만, 원문(items)은 남기지 않는다
export function voiceForDb(v: VoiceFacts): VoiceFacts {
  const naver = { ...v.naver }, voc = { ...v.voc };
  delete naver.items; delete voc.items;
  return { basis: v.basis, naver, voc };
}
// AI 용 — 집계 + 원문(가림·상한 적용됨). 실패한 부분은 note 만.
export function voiceForAi(v: VoiceFacts): Record<string, unknown> {
  const part = <P extends { ok: boolean; note?: string }>(p: P) => (p.ok ? p : { ok: false, note: p.note });
  return { basis: v.basis, slow_threshold_h: VOICE_SLOW_H, naver: part(v.naver), voc: part(v.voc) };
}

// ── 코드 표 '고객의 소리 집계' — '4. 고객의 소리' 섹션 끝에 붙는다(제목 = report-sections VOICE_BLOCK — 팀즈 축약이 이 제목으로 찾는다) ──
const cell = (s: string) => s.replace(/[|\r\n]+/g, "/").replace(/\s+/g, " ").trim().slice(0, 40) || "-";
const n0 = (n: number | null | undefined) => (n == null ? "-" : n.toLocaleString("ko-KR"));
const hrs = (n: number | null | undefined) => (n == null ? "-" : `${n}시간`);
export function renderVoiceTable(v: VoiceFacts | null | undefined, label: string, prevLabel = "전주"): string {
  if (!v) return "";
  const rows: string[] = [];
  const nv = v.naver, vc = v.voc;
  if (nv.ok) {
    for (const k of nv.by_kind ?? []) rows.push(`| 스마트스토어 ${cell(k.kind)} | ${n0(k.count)} | ${n0(k.prev)} |`);
    rows.push(`| 문의 중 미답변 | ${n0(nv.unanswered)} | - |`);
    rows.push(`| 평균 답변 시간 | ${hrs(nv.avg_answer_h)}${nv.max_answer_h != null ? ` (최장 ${nv.max_answer_h}시간)` : ""} | ${hrs(nv.prev_avg_answer_h)} |`);
  }
  if (vc.ok) {
    rows.push(`| VOC 합계 | ${n0(vc.total)} | ${n0(vc.prev_total)} |`);
    for (const c of (vc.by_category ?? []).slice(0, 3)) rows.push(`| VOC ${cell(c.category)} | ${n0(c.count)} | ${n0(c.prev)} |`);
    rows.push(`| VOC 손해 합계 | ${n0(vc.loss_total)}원 | ${vc.prev_loss_total == null ? "-" : `${n0(vc.prev_loss_total)}원`} |`);
  }
  const out = [`### ${VOICE_BLOCK} (${label})`];
  if (rows.length) out.push(`| 구분 | ${cell(label)} | ${cell(prevLabel)} |`, "|---|---|---|", ...rows, "");
  if (v.basis) out.push(`- ${v.basis}`);
  if (nv.ok && nv.synced_at) out.push(nv.synced_by === "heartbeat" ? `- 문의 마지막 수집: ${nv.synced_at}` : `- 문의 대장 마지막 저장: ${nv.synced_at}(새 문의·답변이 들어올 때 갱신)`);
  if (!nv.ok) out.push(`- 스마트스토어 문의: ${nv.note || "집계 없음"}`);
  else {
    if (nv.coverage) out.push(`- 주의: ${nv.coverage}`);
    if (nv.note) out.push(`- 참고: ${nv.note}`);
  }
  if (!vc.ok) out.push(`- VOC: ${vc.note || "집계 없음"}`);
  else if (vc.note) out.push(`- 참고: ${vc.note}`);
  return out.join("\n");
}
