// 은행 입금 자동확인 — 팝빌 계좌조회 API 수집 + 미수금 발주 자동 매칭.
// supabase/migrations/089_bank_deposits.sql 의 bank_deposits 와 1:1.
//
// 흐름: collectDeposits() 가 팝빌에 수집 요청(requestJob) → 완료 대기(getJobState)
//  → 거래내역 조회(search) → 입금(accIn>0)만 bank_deposits 에 저장(tid 중복 무시).
//  runAutoMatch() 가 '확인필요' 입금을 미수금 발주(입금전·일부입금)와 대조해
//  [입금자명 일치 + 금액=잔액 + 후보 1개] 인 것만 자동 처리(입금 기록+상태 변경).
//  나머지는 '확인필요' 로 남아 /b2b/payments 화면에서 원클릭 매칭.
//
// 필요 환경변수: POPBILL_LINK_ID, POPBILL_SECRET_KEY, POPBILL_CORP_NUM(사업자번호),
//  POPBILL_ACCOUNT_NO(계좌번호), POPBILL_USER_ID(팝빌 아이디),
//  선택: POPBILL_BANK_CODE(기본 0004=국민), POPBILL_IS_TEST=1(테스트), POPBILL_IP_RESTRICT=1
//  ※ Vercel 은 고정 IP 가 아니므로 팝빌 회원설정에서 'API 호출 IP 제한'을 해제해야 한다.

import { supabaseAdmin } from "./supabase";
import { logDepositMatched, logDepositsNeedReview } from "./b2b-activity";
import { getKv, setKv } from "./b2b-settings";
import {
  BankDeposit,
  DepositAlias,
  UnpaidOrderLite,
  candidateOrders,
  isKnownDepositName,
  normalizeDepositName,
  ymdToIso,
} from "./b2b-deposit-types";

// 타입·상수·순수 헬퍼는 b2b-deposit-types.ts (클라이언트 안전) — 화면과 라우트가 공유.
export type { BankDeposit, UnpaidOrderLite, DepositCandidate, DepositAlias } from "./b2b-deposit-types";
export { candidateOrders, normalizeDepositName, ymdToIso, depositNameMatch, isKnownDepositName } from "./b2b-deposit-types";

// ─────────────────────────────────────────────
// 입금자명 등록 (bank_deposit_names, migration 090) — 허용 목록 + 업체 별칭
// ─────────────────────────────────────────────
// 테이블 미적용(090) 환경에서도 죽지 않게 빈 배열 폴백 — 그 경우 허용 목록 = 업체명만.
export async function loadDepositAliases(): Promise<DepositAlias[]> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("bank_deposit_names")
      .select("id, company_id, name, company:company_id(name)")
      .order("created_at", { ascending: true });
    if (error) throw error;
    type Row = { id: string; company_id: string | null; name: string; company: { name?: string } | { name?: string }[] | null };
    return ((data ?? []) as unknown as Row[]).map((r) => {
      const company = Array.isArray(r.company) ? r.company[0] : r.company;
      return { id: r.id, company_id: r.company_id, name: r.name, company_name: company?.name ?? null };
    });
  } catch {
    return [];
  }
}

export async function loadCompanyNames(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabaseAdmin().from("companies").select("id, name").order("name");
  if (error) throw error;
  return (data ?? []) as { id: string; name: string }[];
}

// ─────────────────────────────────────────────
// 자동무시 규칙 — 매출 정산·이자 등 B2B 와 무관한 반복 입금자명은 알림 없이 무시.
//  b2b_settings KV(deposits_ignore_rules)에 이름 목록으로 저장, 정규화 후 포함 관계로 비교.
// ─────────────────────────────────────────────
export async function getIgnoreRules(): Promise<string[]> {
  try {
    const raw = await getKv("deposits_ignore_rules");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()) : [];
  } catch {
    return [];
  }
}

export async function setIgnoreRules(rules: string[]): Promise<void> {
  const seen = new Set<string>();
  const clean = rules
    .map((s) => String(s ?? "").trim())
    .filter((s) => {
      if (!s) return false;
      const n = normalizeDepositName(s);
      if (!n || seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  await setKv("deposits_ignore_rules", JSON.stringify(clean));
}

// 입금자명이 규칙에 걸리면 걸린 규칙을, 아니면 null. (규칙이 이름에 포함되면 매칭)
export function matchesIgnoreRule(remark: string | null, rules: string[]): string | null {
  const dep = normalizeDepositName(remark);
  if (!dep) return null;
  for (const r of rules) {
    const rn = normalizeDepositName(r);
    if (rn && dep.includes(rn)) return r;
  }
  return null;
}

// ─────────────────────────────────────────────
// 팝빌 클라이언트 (동적 import — 타입 선언은 popbill.d.ts)
// ─────────────────────────────────────────────
type PopbillTrade = {
  tid: string;
  trdate: string;
  trserial?: string;
  trdt: string;
  accIn: string | number;
  accOut: string | number;
  balance?: string | number;
  remark1?: string;
  remark2?: string;
  remark3?: string;
  remark4?: string;
};

function popbillEnv() {
  return {
    linkID: process.env.POPBILL_LINK_ID || "",
    secretKey: process.env.POPBILL_SECRET_KEY || "",
    corpNum: (process.env.POPBILL_CORP_NUM || "").replace(/-/g, ""),
    userID: process.env.POPBILL_USER_ID || "",
    bankCode: process.env.POPBILL_BANK_CODE || "0004", // 국민은행
    accountNo: (process.env.POPBILL_ACCOUNT_NO || "").replace(/-/g, ""),
  };
}

export function popbillConfigured(): boolean {
  const e = popbillEnv();
  return !!(e.linkID && e.secretKey && e.corpNum && e.accountNo);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let cachedService: any = null;

async function easyFinBank(): Promise<any> {
  if (cachedService) return cachedService;
  const popbill = (await import("popbill")).default as any;
  popbill.config({
    LinkID: popbillEnv().linkID,
    SecretKey: popbillEnv().secretKey,
    IsTest: process.env.POPBILL_IS_TEST === "1",
    IPRestrictOnOff: process.env.POPBILL_IP_RESTRICT === "1", // Vercel 은 고정 IP 아님 — 기본 해제
    UseStaticIP: false,
    UseLocalTimeYN: true,
    defaultErrorHandler: () => {
      /* 각 호출부에서 error 콜백으로 처리 */
    },
  });
  cachedService = popbill.EasyFinBankService();
  return cachedService;
}

function pbError(err: any): Error {
  const code = err?.code !== undefined ? `[${err.code}] ` : "";
  return new Error(`팝빌: ${code}${err?.message || String(err)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// KST 기준 yyyyMMdd (오늘 + offsetDays)
function kstYmd(offsetDays: number): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// ─────────────────────────────────────────────
// 수집: 최근 N일 입금 거래를 bank_deposits 에 적재
// ─────────────────────────────────────────────
export async function collectDeposits(days = 7): Promise<{ fetched: number; inserted: BankDeposit[] }> {
  const svc = await easyFinBank();
  const { corpNum, userID, bankCode, accountNo } = popbillEnv();
  const sdate = kstYmd(-days);
  const edate = kstYmd(0);

  // 1) 수집 요청 → JobID
  const jobID: string = await new Promise((resolve, reject) => {
    svc.requestJob(corpNum, bankCode, accountNo, sdate, edate, userID,
      (id: string) => resolve(id), (e: any) => reject(pbError(e)));
  });

  // 2) 완료 대기 (보통 수 초 — 최대 ~21초)
  let state: any = null;
  for (let i = 0; i < 14; i++) {
    await sleep(1500);
    state = await new Promise((resolve, reject) => {
      svc.getJobState(corpNum, jobID, userID, (s: any) => resolve(s), (e: any) => reject(pbError(e)));
    });
    if (Number(state?.jobState) === 3) break;
  }
  if (Number(state?.jobState) !== 3) {
    throw new Error("팝빌 수집이 제한시간 내에 끝나지 않았습니다. 잠시 후 다시 동기화하세요.");
  }
  if (Number(state?.errorCode) !== 1) {
    throw new Error(`팝빌 수집 실패: ${state?.errorReason || `코드 ${state?.errorCode}`}`);
  }

  // 3) 결과 조회 — 입금(I)만, 최근순 최대 1000건
  const result: any = await new Promise((resolve, reject) => {
    svc.search(corpNum, jobID, ["I"], "", 1, 1000, "D", userID,
      (r: any) => resolve(r), (e: any) => reject(pbError(e)));
  });
  const trades: PopbillTrade[] = ((result?.list ?? []) as PopbillTrade[]).filter(
    (t) => Number(t.accIn) > 0
  );
  if (trades.length === 0) return { fetched: 0, inserted: [] };

  // 4) tid 중복 제외 후 적재
  const sb = supabaseAdmin();
  const tids = trades.map((t) => String(t.tid));
  const { data: existing, error: exErr } = await sb.from("bank_deposits").select("tid").in("tid", tids);
  if (exErr) throw exErr;
  const known = new Set((existing ?? []).map((r: { tid: string }) => r.tid));
  const rows = trades
    .filter((t) => !known.has(String(t.tid)))
    .map((t) => ({
      tid: String(t.tid),
      trdate: String(t.trdate),
      trdt: String(t.trdt),
      amount: Number(t.accIn),
      balance: t.balance === undefined || t.balance === null ? null : Number(t.balance),
      remark: [t.remark1, t.remark2, t.remark3, t.remark4]
        .map((s) => (s ?? "").trim())
        .filter(Boolean)
        .join(" ") || null,
      raw: t as unknown as Record<string, unknown>,
    }));
  if (rows.length === 0) return { fetched: trades.length, inserted: [] };

  const { data: insertedRows, error: insErr } = await sb.from("bank_deposits").insert(rows).select();
  if (insErr) throw insErr;
  return { fetched: trades.length, inserted: (insertedRows ?? []) as BankDeposit[] };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─────────────────────────────────────────────
// 매칭
// ─────────────────────────────────────────────
// 미수금 발주(입금전·일부입금) + 입금 합계 (unpaid API 와 같은 계산 — 라우트 공용화 대신 로컬 유지)
export async function loadUnpaidOrders(): Promise<UnpaidOrderLite[]> {
  const sb = supabaseAdmin();
  const { data: orders, error: oErr } = await sb
    .from("orders")
    .select("id, order_no, payment_status, total, company_id, company:company_id(name)")
    .in("payment_status", ["입금전", "일부입금"]);
  if (oErr) throw oErr;

  type Row = {
    id: string; order_no: string; payment_status: string; total: number; company_id: string;
    company: { name?: string } | { name?: string }[] | null;
  };
  const list = (orders ?? []) as unknown as Row[];
  if (list.length === 0) return [];

  const { data: pays, error: pErr } = await sb
    .from("payments")
    .select("order_id, amount")
    .in("order_id", list.map((o) => o.id));
  if (pErr) throw pErr;
  const paidMap = new Map<string, number>();
  for (const p of pays ?? []) {
    paidMap.set(p.order_id, (paidMap.get(p.order_id) || 0) + Number(p.amount || 0));
  }

  return list.map((o) => {
    const company = Array.isArray(o.company) ? o.company[0] : o.company;
    const total = Number(o.total) || 0;
    const paid = paidMap.get(o.id) || 0;
    return {
      id: o.id,
      order_no: o.order_no,
      company_id: o.company_id,
      company_name: company?.name ?? "(미지정)",
      payment_status: o.payment_status,
      total,
      paid,
      remaining: total - paid,
    };
  });
}

// 매칭 확정 — payments 기록 + 발주 상태 변경 + 입금 행 갱신 + 활동로그.
// mode "자동" 은 runAutoMatch, "수동" 은 화면 원클릭(actor = 작업자명).
export async function applyMatch(
  dep: BankDeposit,
  order: UnpaidOrderLite,
  mode: "자동" | "수동",
  actor?: string | null
): Promise<void> {
  const sb = supabaseAdmin();
  const { data: pay, error: payErr } = await sb
    .from("payments")
    .insert({
      order_id: order.id,
      amount: Number(dep.amount),
      paid_at: ymdToIso(dep.trdate),
      method: "계좌이체",
      reference: dep.tid,
      notes: `${mode} 입금매칭${dep.remark ? ` · ${dep.remark}` : ""}`,
    })
    .select()
    .single();
  if (payErr) throw payErr;

  const newStatus = order.paid + Number(dep.amount) >= order.total ? "입금완료" : "일부입금";
  const { error: ordErr } = await sb.from("orders").update({ payment_status: newStatus }).eq("id", order.id);
  if (ordErr) throw ordErr;

  const { error: depErr } = await sb
    .from("bank_deposits")
    .update({
      status: mode === "자동" ? "자동매칭" : "수동매칭",
      matched_order_id: order.id,
      payment_id: (pay as { id: string }).id,
      matched_by: mode === "자동" ? "자동" : actor ?? null,
      matched_at: new Date().toISOString(),
    })
    .eq("id", dep.id);
  if (depErr) throw depErr;

  await logDepositMatched(order.id, Number(dep.amount), dep.remark, mode, actor ?? null);
}

// '확인필요' 전체를 자동 매칭 시도. notifyIds = 이번 수집에서 새로 들어온 입금 id —
//  자동 매칭 안 된 신규 건만 Flow 로 '확인필요' 알림(재동기화 때마다 옛 건 재알림 방지).
//
// 허용 목록 정책 — 입금의 다양성이 거래처의 다양성보다 넓다(급여·매출 정산·이자 등):
//  1) 자동 매칭: 이름(업체명·별칭) 일치 + 금액=잔액 + 후보 1개 → 입금 기록+상태 변경
//  2) 자동무시 규칙에 걸리면 → 무시 (명시적 차단이 허용보다 우선)
//  3) 등록된 이름(업체명·별칭·일반 등록)이면 → 확인필요 + 알림
//  4) 미등록 이름 → 알림 없이 '무시(미등록)' — 단, 금액이 어떤 발주의 잔액과 정확히
//     일치하면 실제 거래처일 가능성이 높아 예외로 확인필요에 올린다.
export async function runAutoMatch(
  notifyIds: Set<string>
): Promise<{ autoMatched: number; needReview: number; autoIgnored: number }> {
  const sb = supabaseAdmin();
  const { data: pendingRows, error } = await sb
    .from("bank_deposits")
    .select("*")
    .eq("status", "확인필요")
    .order("trdt", { ascending: true });
  if (error) throw error;
  const pending = (pendingRows ?? []) as BankDeposit[];
  if (pending.length === 0) return { autoMatched: 0, needReview: 0, autoIgnored: 0 };

  const unpaid = await loadUnpaidOrders();
  const rules = await getIgnoreRules();
  const aliases = await loadDepositAliases();
  const companyNames = (await loadCompanyNames()).map((c) => c.name);
  let autoMatched = 0;
  let autoIgnored = 0;
  const newReview: BankDeposit[] = [];

  for (const dep of pending) {
    const cands = candidateOrders(dep, unpaid, aliases);
    const sure = cands.filter((c) => c.nameHit && c.amountHit);
    if (sure.length === 1) {
      await applyMatch(dep, sure[0].order, "자동");
      autoMatched++;
      // 방금 완납된 발주는 이후 입금의 후보에서 제외
      const idx = unpaid.findIndex((o) => o.id === sure[0].order.id);
      if (idx >= 0) {
        unpaid[idx].paid += Number(dep.amount);
        unpaid[idx].remaining -= Number(dep.amount);
        if (unpaid[idx].remaining <= 0) unpaid.splice(idx, 1);
      }
      continue;
    }
    // 발주 매칭이 안 됐을 때만 무시·미등록 판정 — 실제 발주 입금은 매칭이 항상 우선
    const ignoredBy = matchesIgnoreRule(dep.remark, rules)
      ? "자동규칙"
      : !isKnownDepositName(dep.remark, companyNames, aliases) && !cands.some((c) => c.amountHit)
        ? "미등록"
        : null;
    if (ignoredBy) {
      const { error: igErr } = await sb
        .from("bank_deposits")
        .update({ status: "무시", matched_by: ignoredBy })
        .eq("id", dep.id);
      if (!igErr) {
        autoIgnored++;
        continue;
      }
    }
    if (notifyIds.has(dep.id)) newReview.push(dep);
  }

  if (newReview.length > 0) {
    await logDepositsNeedReview(newReview.map((d) => ({ amount: Number(d.amount), remark: d.remark })));
  }
  return { autoMatched, needReview: newReview.length, autoIgnored };
}

// 테이블 미생성(마이그레이션 089 미적용) 판별 — 라우트 폴백용
export function isMissingDepositsTable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : JSON.stringify(err ?? "");
  return /bank_deposits/.test(msg) && /(does not exist|schema cache|찾을 수 없)/i.test(msg);
}
