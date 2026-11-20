// 오디언스 추출 — 탈리 설문 응답자 빼기(2026-11-20 대표: "카페24에서 대상 추출 → 탈리 응답자 제외 → 대상자 추출"). 서버 전용.
//  이미 설문에 답한 고객에게 같은 안내를 또 보내지 않기 위함이다. 고른 탈리 폼의 응답을 그 자리에서 탈리 API 로 읽고(저장하지 않는다),
//  응답에 적힌 전화번호를 고객 키(sales-normalize.customerKey — 매출 주문과 같은 계산)로 바꿔 조건에 맞은 고객에서 뺀다.
//  ■ 읽지 못하면 멈춘다 — 탈리 호출이 실패하거나 응답이 상한을 넘으면 오류로 끝낸다. 일부만 빼고 뽑으면 답한 고객에게 다시 나간다.
//  ■ 추출한 시점 기준이다 — 그 뒤에 답한 고객은 남는다. [다시 추출]은 조건에 든 폼을 다시 읽으므로 발송 직전에 누르면 된다.
//  ■ 응답자의 전화번호는 서버 밖으로 나가지 않는다 — 화면과 기록에는 건수만 남는다.
import { customerKey } from "./sales-normalize";
import { findPhone, normalizePhone } from "./form-sms";
import { getTallyApiKey, tallyFetch, mapTallySubmission, type TallyQ, type TallySub } from "./voc-tally";

export type ExcludeForm = { id: string; name: string };
export const MAX_EXCLUDE_FORMS = 5;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;   // 폼 하나에 응답 5,000건까지 — 넘으면 일부만 빼게 되므로 멈춘다(탈리 호출 한도: 분당 100회)

// 화면·기록에서 온 값 다듬기 — 폼 ID 는 탈리가 주는 짧은 영숫자다
export function normalizeExcludeForms(raw: unknown): ExcludeForm[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: ExcludeForm[] = [];
  for (const x of raw as { id?: unknown; name?: unknown }[]) {
    const id = String(x?.id ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String(x?.name ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 100) || id });
    if (out.length >= MAX_EXCLUDE_FORMS) break;
  }
  return out.length ? out : undefined;
}
export const excludeText = (forms: ExcludeForm[]): string => `탈리 ${forms.map((f) => `'${f.name}'`).join(", ")} 응답자 제외`;

export type TallyExclusion = { keys: Set<string>; responses: number; noPhone: number };
// 고른 폼들의 응답자 → 고객 키 묶음. responses = 읽은 응답 수, noPhone = 전화번호를 찾지 못한 응답 수(이 응답자는 빼지 못한다).
export async function loadTallyExclusion(forms: ExcludeForm[]): Promise<TallyExclusion> {
  const apiKey = await getTallyApiKey();
  if (!apiKey) throw new Error("탈리 API 키가 없어 응답자를 읽지 못했습니다 — 관리자 › 설정 › 연결에서 Tally 키를 넣으세요.");
  const keys = new Set<string>();
  let responses = 0, noPhone = 0;
  for (const form of forms) {
    const qmap = new Map<string, TallyQ>();
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new Error(`탈리 '${form.name}' 응답이 ${(PAGE_SIZE * MAX_PAGES).toLocaleString("ko-KR")}건을 넘어 다 읽지 못했습니다 — 일부만 빼면 답한 고객에게 다시 나가므로 멈췄습니다.`);
      let json: { questions?: TallyQ[]; submissions?: TallySub[]; hasMore?: boolean };
      try { json = await tallyFetch(`/forms/${encodeURIComponent(form.id)}/submissions?filter=completed&limit=${PAGE_SIZE}&page=${page}`, apiKey); }
      catch (e) { throw new Error(`탈리 '${form.name}' 응답을 읽지 못했습니다 — ${e instanceof Error ? e.message : "오류"}`); }
      for (const q of json.questions || []) if (q.id) qmap.set(q.id, q);
      const list = json.submissions || [];
      for (const s of list) {
        if (!s?.id) continue;
        responses++;
        const key = phoneKey(findPhone((mapTallySubmission(s, qmap, form.id) as { answers?: unknown }).answers));
        if (key) keys.add(key); else noPhone++;
      }
      if (!json.hasMore || list.length === 0) break;
    }
  }
  return { keys, responses, noPhone };
}
// 휴대폰 번호(01012345678 꼴) → 고객 키. 매출 주문의 고객 키와 같은 계산이라 그대로 비교된다.
function phoneKey(phone: string | null): string {
  const p = normalizePhone(phone);
  return p ? customerKey(p) : "";
}

// 조건에 맞은 고객에서 응답자를 뺀다 — removed = 빠진 고객 수
export function dropResponders<T extends { customer_key: string }>(rows: T[], ex: TallyExclusion): { rows: T[]; removed: number } {
  const kept = rows.filter((r) => !ex.keys.has(r.customer_key));
  return { rows: kept, removed: rows.length - kept.length };
}
// 화면·엑셀에 보일 집계 — 전화번호는 없다
export type TallyStat = { forms: string[]; responses: number; noPhone: number; removed: number };
