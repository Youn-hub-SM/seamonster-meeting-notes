// 정기배송 분석 결과 스냅샷 — 서버 계산(2026-10-07 대표: "데이터가 계속 축적돼야 의미" → 매일 자동 저장).
//  public/subscription-dashboard.html 의 buildOrdersFromRows · applyFilters(기본 필터) · renderKpis · getCurrentSnapshot 을
//  그대로 옮겼다. 화면 계산을 바꾸면 여기도 같이 바꿔야 추세가 끊기지 않는다(짝 검증: 화면 코드를 그대로 돌린 값과 비교하는 테스트).
//  입력은 /api/subscription/data 와 같은 행(카페24 관리자 CSV 와 같은 열, toDashboardRows).

type Row = Record<string, string>;
type Opt = { raw: string; qty: number; status: string; nextPay: string; cancelDate: string; round: string };
type Order = {
  id: string; signDate: string; applicant: string; applicantId: string; applicantHash: string; recipientHash: string;
  product: string; cycle: string; status: string; nextPay: string; round: string; cancelDate: string; options: Opt[];
};

// 화면 HTML 의 입력칸 기본값(저장된 제외 기본값이 없을 때) — public/subscription-dashboard.html #fExcludeNames·#fExcludeOpts
export const DEFAULT_EXCLUDE_NAMES = "윤현석, 안예지";
export const DEFAULT_EXCLUDE_OPTS = "선택안함";

export function parseList(s: string | null | undefined): string[] {
  return String(s || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}
function statusBucket(s: string): "active" | "pause" | "cancel" | "unknown" {
  if (!s) return "unknown";
  if (s === "이용중") return "active";
  if (s.startsWith("일시정지")) return "pause";
  if (s.startsWith("해지")) return "cancel";
  return "unknown";
}
function parseOptionGrams(raw: string): number {
  if (!raw) return 0;
  const totalKg = /총\s*([\d.]+)\s*kg/.exec(raw);
  if (totalKg) return parseFloat(totalKg[1]) * 1000;
  const weight = /중량=([\d.]+)\s*(g|kg)/.exec(raw);
  const qty = /수량=(\d+)/.exec(raw);
  if (weight && qty) return parseFloat(weight[1]) * (weight[2] === "kg" ? 1000 : 1) * parseInt(qty[1], 10);
  return 0;
}
// 화면은 브라우저 지역 시각 자정끼리 뺀다 — 한국(서머타임 없음)에선 UTC 자정끼리와 같다
function diffDays(a: string, b: string): number | null {
  if (!a || !b) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
function pct(num: number, denom: number): number | null {
  if (!denom) return null;
  return Math.round((num / denom) * 1000) / 10;
}
function cycleDays(c: string): number {
  let m = /(\d+)\s*주/.exec(c || "");
  if (m) return Number(m[1]) * 7;
  m = /(\d+)\s*개월/.exec(c || "");
  if (m) return Number(m[1]) * 30;
  return 9999;
}
const cycleSort = (a: string, b: string) => cycleDays(a) - cycleDays(b);

function buildOrdersFromRows(rows: Row[]): Order[] {
  const byId = new Map<string, Order>();
  for (const r of rows) {
    const id = r["신청번호"];
    if (!byId.has(id)) {
      byId.set(id, {
        id, signDate: r["신청일"] || "", applicant: r["신청자"] || "", applicantId: r["신청자아이디"] || "",
        applicantHash: r["신청자해시"] || "", recipientHash: r["수령자해시"] || "",
        product: r["상품명"] || "", cycle: r["배송주기"] || "", status: r["정기배송 이용여부"] || "",
        nextPay: r["결제예정일"] || "", round: r["회차"] || "", cancelDate: r["해지일"] || "", options: [],
      });
    }
    byId.get(id)!.options.push({
      raw: r["옵션"] || "", qty: Number(r["수량"] || 0),
      status: r["정기배송 이용여부"] || "", nextPay: r["결제예정일"] || "", cancelDate: r["해지일"] || "", round: r["회차"] || "",
    });
  }
  // 대표 상태 = 이용중 > 일시정지(구매자>관리자) > 해지(구매자>관리자), 해지일 최댓값, 회차 최댓값, 이용중 결제예정일 최솟값
  const statusRank = (s: string) => {
    const b = statusBucket(s);
    const admin = s.includes("관리자") ? 1 : 0;
    return b === "active" ? 0 : b === "pause" ? 1 + admin : b === "cancel" ? 3 + admin : 9;
  };
  for (const o of byId.values()) {
    let best: string | null = null;
    let maxCancel = "", maxRound = 0, minNextPay = "";
    for (const opt of o.options) {
      if (opt.status && (best === null || statusRank(opt.status) < statusRank(best))) best = opt.status;
      if (opt.cancelDate && opt.cancelDate > maxCancel) maxCancel = opt.cancelDate;
      const r = parseInt(opt.round, 10) || 0;
      if (r > maxRound) maxRound = r;
      if (statusBucket(opt.status) === "active" && opt.nextPay && (!minNextPay || opt.nextPay < minNextPay)) minNextPay = opt.nextPay;
    }
    if (best !== null) o.status = best;
    if (maxCancel) o.cancelDate = maxCancel;
    if (maxRound > 0) o.round = String(maxRound);
    if (minNextPay) o.nextPay = minNextPay;
  }
  return Array.from(byId.values()).sort((a, b) => b.signDate.localeCompare(a.signDate));
}

export type SnapshotInput = {
  rows: Row[];
  dataDate: string;             // 기준일(자동 수집은 수집한 날 KST)
  fileName: string;             // 화면과 같은 '카페24 자동 수집 YYYY-MM-DD'
  excludeNameHashes: string[];  // 저장된 '제외할 이름'의 암호화 값(subHash name)
  excludeOpts: string[];        // 저장된 '제외할 옵션 키워드'
  savedAt?: string;             // KST 'YYYY-MM-DD HH:MM:SS'
};

// 화면 getCurrentSnapshot() 과 같은 키·같은 표기(문자열 % · 'N.NN kg')
export function computeSubscriptionSnapshot(inp: SnapshotInput) {
  const today = inp.dataDate;
  // 1단계: 행 단위 옵션 키워드 제외
  const rows = inp.rows.filter((r) => r["신청번호"]).filter((r) => {
    const opt = r["옵션"] || "";
    return !inp.excludeOpts.some((kw) => kw && opt.includes(kw));
  });
  const allOrdersUnfiltered = buildOrdersFromRows(inp.rows.filter((r) => r["신청번호"]));
  // 칩 기본값 — 상태는 '관리자' 들어간 것 제외, 주기·상품은 전부(빈 값은 칩이 없어 걸러진다)
  const statuses = new Set(allOrdersUnfiltered.map((o) => o.status).filter(Boolean).filter((s) => !s.includes("관리자")));
  const cycles = new Set(allOrdersUnfiltered.map((o) => o.cycle).filter(Boolean));
  const products = new Set(allOrdersUnfiltered.map((o) => o.product).filter(Boolean));
  const ex = inp.excludeNameHashes.filter(Boolean);
  const orders = buildOrdersFromRows(rows).filter((o) => {
    if (!o.options.length) return false;
    if (ex.length && ex.some((h) => o.applicantHash === h || o.recipientHash === h)) return false;
    if (statuses.size && !statuses.has(o.status)) return false;
    if (cycles.size && !cycles.has(o.cycle)) return false;
    if (products.size && !products.has(o.product)) return false;
    return true;
  });

  const memberKey = (o: Order) => o.applicantId || `(이름)${o.applicant}`;
  const activeMembers = new Set<string>(), pauseMembers = new Set<string>();
  for (const o of orders) {
    const k = memberKey(o);
    const b = statusBucket(o.status);
    if (b === "active") activeMembers.add(k);
    if (b === "pause") pauseMembers.add(k);
  }
  // 첫결제 리드타임 = 회차 1·이용중 신청건(신청일→결제예정일)의 중앙값, 없으면 D+2
  const leadCandidates = orders
    .filter((o) => statusBucket(o.status) === "active" && (parseInt(o.round, 10) || 0) === 1 && o.nextPay && o.signDate)
    .map((o) => diffDays(o.signDate, o.nextPay))
    .filter((d): d is number => d != null && d > 0)
    .sort((a, b) => a - b);
  const leadTime = leadCandidates.length ? leadCandidates[Math.floor((leadCandidates.length - 1) / 2)] : 2;
  const eligibleFP = orders.filter((o) => o.signDate && (diffDays(o.signDate, today) ?? -1) >= leadTime);
  const passed = eligibleFP.filter((o) => {
    if (statusBucket(o.status) !== "cancel") return true;
    return !!o.cancelDate && (diffDays(o.signDate, o.cancelDate) ?? -1) >= leadTime;
  });
  const firstPayRate = pct(passed.length, eligibleFP.length);
  const eligible = orders.filter((o) => o.signDate);
  const rate3 = pct(eligible.filter((o) => parseInt(o.round, 10) >= 3).length, eligible.length);
  const rate4 = pct(eligible.filter((o) => parseInt(o.round, 10) >= 4).length, eligible.length);
  let totalGrams = 0, weightedOrders = 0;
  for (const o of orders) {
    let g = 0;
    for (const opt of o.options) g += parseOptionGrams(opt.raw) * (opt.qty || 1);
    if (g > 0) { totalGrams += g; weightedOrders++; }
  }
  const avgAOVkg = weightedOrders ? (totalGrams / weightedOrders / 1000).toFixed(2) : "-";

  const memberAlive = new Map<string, boolean>();
  for (const o of orders) {
    const k = memberKey(o);
    if (!memberAlive.has(k)) memberAlive.set(k, false);
    if (statusBucket(o.status) !== "cancel") memberAlive.set(k, true);
  }
  const cycleCounts: Record<string, number> = {};
  orders.filter((o) => ["active", "pause"].includes(statusBucket(o.status)))
    .forEach((o) => { const c = o.cycle || "(미상)"; cycleCounts[c] = (cycleCounts[c] || 0) + 1; });

  return {
    savedAt: inp.savedAt ?? new Date(Date.now() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 19),
    dataDate: inp.dataDate,
    fileName: inp.fileName,
    filteredOrders: orders.length,
    totalOrders: allOrdersUnfiltered.length,
    activeMembers: activeMembers.size,
    pauseMembers: pauseMembers.size,
    firstPayRate: firstPayRate !== null ? `${firstPayRate}%` : "-",
    reach3Rate: rate3 !== null ? `${rate3}%` : "-",
    reach4Rate: rate4 !== null ? `${rate4}%` : "-",
    avgWeightKg: `${avgAOVkg} kg`,
    totalCancels: orders.filter((o) => statusBucket(o.status) === "cancel").length,
    lostMembers: Array.from(memberAlive.values()).filter((v) => !v).length,
    totalMembers: memberAlive.size,
    cycleMix: Object.keys(cycleCounts).sort(cycleSort).map((c) => `${c} ${cycleCounts[c]}`).join(" · "),
  };
}
export type SubscriptionSnapshot = ReturnType<typeof computeSubscriptionSnapshot>;
