// CRM 메시지맵 초기 데이터 + CSV 가져오기 파서.
//  시드 = 구 카페24 crm_message_map.html 의 폴백 데이터(= crm_message_map_template.xlsx 와 동일한 8단계·30개).
//  구글시트 웹게시 CSV 는 2026-07 기준 410(게시 중단)이라, 이 스냅샷이 유일한 확보 원천.
import type { CrmMessageInput, CrmPerf } from "./crm";

type SeedMsg = {
  title: string; status: string; ch: string; timing: string; detail: string;
  msg?: string; perf?: CrmPerf;
};
type SeedStage = { stage: string; sub: string; msgs: SeedMsg[] };

const SEED_STAGES: SeedStage[] = [
  {
    stage: "유입/인지", sub: "첫 접점", msgs: [
      { title: "체험단 안내 링크", status: "active", ch: "kakao", timing: "선정 시", detail: "구글폼/스모어 > 신규 필터링 후 발송. Apps Script 자동화 완료." },
      { title: "SNS 광고 > 랜딩", status: "active", ch: "manual", timing: "상시", detail: "메타 광고 > 정기배송 랜딩 또는 상품페이지." },
      { title: "블로그/가이드 SEO", status: "active", ch: "manual", timing: "상시", detail: "blog.seamonster.kr 자연 유입. SEO 교육 진행 중." },
      { title: "첫 방문 웰컴 쿠폰", status: "gap", ch: "cafe24", timing: "첫 방문 즉시", detail: "미운영. 첫 방문 이탈률 감소 + 전환율 개선 기대.", msg: "[씨몬스터] 첫 방문 감사합니다\n\n지금 가입하면 첫 주문 1,000원 할인 쿠폰을 드립니다.\n3만원 이상 주문 시 배송비도 무료입니다.\n\n> 쿠폰 받기" },
    ],
  },
  {
    stage: "첫 구매", sub: "전환 직후", msgs: [
      { title: "주문 완료 알림", status: "auto", ch: "cafe24", timing: "결제 즉시", detail: "카페24 기본 자동 발송." },
      { title: "입금 확인 알림", status: "auto", ch: "cafe24", timing: "입금 시", detail: "무통장 한정 자동 발송." },
      { title: "첫 구매 환영 메시지", status: "gap", ch: "kakao", timing: "결제 후 1시간", detail: "미운영. 브랜드 첫인상 + 조리 안내.", msg: "[씨몬스터] 주문 감사합니다\n\n{고객명}님, 첫 주문이시네요." },
      { title: "카카오채널 추가 유도", status: "gap", ch: "kakao", timing: "결제 후 1일", detail: "미운영. 미확보 시 이후 알림톡 발송 불가.", msg: "[씨몬스터] 다음 주문이 더 편해집니다\n\n카카오채널 추가 시\n- 배송 알림 카카오톡 수신\n- 500원 할인쿠폰 즉시 지급\n\n> 채널 추가하기" },
    ],
  },
  {
    stage: "배송/수령", sub: "상품 경험 시작", msgs: [
      { title: "발송 알림", status: "auto", ch: "cafe24", timing: "출고 시", detail: "카페24 자동 발송. 운송장번호 포함." },
      { title: "배송 완료 알림", status: "auto", ch: "cafe24", timing: "배송 완료", detail: "카페24 자동 발송." },
      { title: "리플렛 동봉", status: "active", ch: "leaflet", timing: "상품과 함께", detail: "322건 설문: 진입장벽 48건, 기대정보 부재 31건." },
      { title: "해동/조리법 안내", status: "gap", ch: "kakao", timing: "배송 완료 당일", detail: "미운영. 리플렛 미열람의 디지털 보완.", msg: "[씨몬스터] {고객명}님, 상품이 도착했습니다" },
    ],
  },
  {
    stage: "섭취/경험", sub: "수령 후 1~7일", msgs: [
      { title: "식단일기 이벤트", status: "active", ch: "manual", timing: "주문 건당 1회", detail: "전원 1,000원, 위클리 식단러 5,000원." },
      { title: "리뷰 작성 요청", status: "gap", ch: "kakao", timing: "배송 후 5~7일", detail: "미운영. 별도 리뷰 유도 없음." },
      { title: "만족도 확인 (NPS)", status: "gap", ch: "kakao", timing: "배송 후 7일", detail: "미운영. 이탈 사전 감지." },
    ],
  },
  {
    stage: "재구매 유도", sub: "구매 후 2~4주", msgs: [
      { title: "재구매 리마인더", status: "gap", ch: "kakao", timing: "재구매 주기 도래", detail: "미운영. 데이터 있으나 메시지 미연결." },
      { title: "크로스셀 추천", status: "gap", ch: "kakao", timing: "첫 구매 후 2주", detail: "미운영. 구매 이력 기반 추천." },
      { title: "정기배송 전환 제안", status: "gap", ch: "kakao", timing: "2회 구매 시점", detail: "미운영. 랜딩페이지만 존재." },
    ],
  },
  {
    stage: "정기배송", sub: "구독 고객", msgs: [
      { title: "정기배송 알림톡", status: "active", ch: "kakao", timing: "마감 3일 전", detail: "운영 중. 솔라피, Sheets URL 자동 생성.", perf: { sent: 58, reached: 55, opened: 47, clicked: 31, converted: 22, revenue: 748000 } },
      { title: "결제 완료 안내", status: "active", ch: "kakao", timing: "결제 후", detail: "수동 결제 후 완료 안내." },
      { title: "회차 혜택 알림", status: "gap", ch: "kakao", timing: "회차 전환", detail: "미운영. 할인 누적 체감 강화." },
      { title: "해지 방지", status: "gap", ch: "cafe24", timing: "해지 요청 시", detail: "미운영. 건너뛰기/주기 변경 대안." },
    ],
  },
  {
    stage: "이탈 방지", sub: "구매 중단 감지", msgs: [
      { title: "장바구니 리타겟팅", status: "active", ch: "manual", timing: "이탈 후", detail: "CRM 캠페인 운영 중." },
      { title: "60일 이탈자", status: "active", ch: "kakao", timing: "60일 경과", detail: "운영 중. 전환율 추적.", perf: { sent: 245, reached: 230, opened: 142, clicked: 38, converted: 12, revenue: 456000 } },
      { title: "90일 이탈자", status: "active", ch: "kakao", timing: "90일 경과", detail: "운영 중. 60일 대비 비교.", perf: { sent: 189, reached: 178, opened: 98, clicked: 21, converted: 6, revenue: 234000 } },
      { title: "체험단 3회 유도", status: "active", ch: "kakao", timing: "체험 후", detail: "운영 중. 필터링 자동화 완료.", perf: { sent: 120, reached: 115, opened: 89, clicked: 34, converted: 15, revenue: 525000 } },
      { title: "180일+ 윈백", status: "gap", ch: "kakao", timing: "6개월 이상", detail: "미운영. 추가 시퀀스 없음." },
    ],
  },
  {
    stage: "충성 고객", sub: "VIP / 장기", msgs: [
      { title: "VIP 등급 전환", status: "gap", ch: "kakao", timing: "기준 충족 시", detail: "미운영. 등급 기준 미정립." },
      { title: "장기 고객 감사", status: "gap", ch: "kakao", timing: "1주년 등", detail: "미운영." },
      { title: "신제품 사전 안내", status: "gap", ch: "kakao", timing: "출시 전", detail: "미운영. 캔/레토르트/시즈닝 활용." },
    ],
  },
];

export function seedMessages(): CrmMessageInput[] {
  const out: CrmMessageInput[] = [];
  SEED_STAGES.forEach((s, si) => {
    s.msgs.forEach((m, mi) => {
      out.push({
        stage_num: si + 1, stage: s.stage, sub: s.sub,
        title: m.title, status: m.status, channel: m.ch, timing: m.timing,
        detail: m.detail, msg: m.msg || "", img_url: "",
        links: {}, perf: m.perf || {}, tags: "",
        sort_order: mi + 1, active: true,
        start_date: "", end_date: "", customer: "", msg_type: "",
      });
    });
  });
  return out;
}

// ── CSV 가져오기 ── 구 맵/템플릿과 같은 한글 헤더. 따옴표·셀 내 줄바꿈 처리.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuote) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') inQuote = false;
      else field += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r" && next === "\n") { row.push(field); field = ""; rows.push(row); row = []; i++; }
      else if (c === "\n" || c === "\r") { row.push(field); field = ""; rows.push(row); row = []; }
      else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const COL_MAP: Record<string, string> = {
  "스테이지": "stage", "부제": "sub", "메시지명": "title",
  "상태": "status", "채널": "channel", "발송시점": "timing",
  "상세설명": "detail", "메시지 내용/초안": "msg", "이미지url": "img_url",
  "솔라피 url": "link_solapi", "카페24 url": "link_cafe24",
  "메타광고 url": "link_meta", "sheets url": "link_sheets",
  "카카오채널 url": "link_channel", "블로그 url": "link_blog", "온사이트 url": "link_onsite",
  "발송수": "perf_sent", "도달": "perf_reached", "열람": "perf_opened",
  "클릭": "perf_clicked", "전환": "perf_converted", "매출": "perf_revenue",
  "태그": "tags", "스테이지번호": "stage_num",
};

// 시트에 한글 라벨로 적었어도 키로 수렴(관대한 매핑). 상태는 개편된 2종(활성/비활성)으로.
function toStatusKey(v: string): string {
  const s = v.trim().toLowerCase();
  if (/^비활성|inactive|공백|미완|미운영|빈|중단|중지|gap|paused/.test(s)) return "inactive";
  if (/활성|운영|자동|active|auto/.test(s)) return "active";
  return "inactive"; // 알 수 없는 값은 '나가는 중'으로 오해하지 않게
}
function toChannelKey(v: string): string {
  const s = v.trim().toLowerCase();
  if (["kakao", "solapi", "cafe24", "bloomai", "manual", "custom", "onsite", "leaflet"].includes(s)) return s;
  if (/솔라피/.test(s)) return "solapi";
  if (/블룸/.test(s)) return "bloomai";
  if (/알림톡|카카오/.test(s)) return "kakao";
  if (/카페24|cafe/.test(s)) return "cafe24";
  if (/맞춤|타겟/.test(s)) return "custom";
  if (/온사이트/.test(s)) return "onsite";
  if (/리플렛|동봉|전단/.test(s)) return "leaflet";
  return "manual";
}

export function csvToMessages(csv: string): CrmMessageInput[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const ci: Record<string, number> = {};
  header.forEach((h, i) => { ci[COL_MAP[h] || h] = i; });
  const g = (row: string[], key: string) => (ci[key] !== undefined && row[ci[key]] !== undefined ? String(row[ci[key]]).trim() : "");
  const gn = (row: string[], key: string) => { const v = g(row, key).replace(/[^\d-]/g, ""); return v ? parseInt(v, 10) : undefined; };

  const stageNums = new Map<string, number>(); // 스테이지번호 없으면 등장 순서로 채번
  const sortSeq = new Map<string, number>();
  const out: CrmMessageInput[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const stage = g(row, "stage");
    const title = g(row, "title");
    if (!stage || !title) continue;
    if (!stageNums.has(stage)) stageNums.set(stage, gn(row, "stage_num") ?? stageNums.size + 1);
    const sort = (sortSeq.get(stage) || 0) + 1;
    sortSeq.set(stage, sort);

    // 링크는 통합 1개 — 시트의 종류별 URL 중 첫 번째를 채택(normalize 도 같은 규칙)
    const links: Record<string, string> = {};
    for (const lt of ["solapi", "cafe24", "meta", "sheets", "channel", "blog", "onsite"]) {
      const u = g(row, `link_${lt}`);
      if (u) { links.url = u; break; }
    }
    const perf: CrmPerf = {};
    (["sent", "reached", "opened", "clicked", "converted", "revenue"] as (keyof CrmPerf)[]).forEach((k) => {
      const v = gn(row, `perf_${k}`);
      if (v !== undefined) perf[k] = v;
    });

    out.push({
      stage_num: stageNums.get(stage)!, stage, sub: g(row, "sub"),
      title, status: toStatusKey(g(row, "status")), channel: toChannelKey(g(row, "channel")),
      timing: g(row, "timing"), detail: g(row, "detail"), msg: g(row, "msg"), img_url: g(row, "img_url"),
      links, perf, tags: g(row, "tags"), sort_order: sort, active: true,
      start_date: "", end_date: "", customer: "", msg_type: "",
    });
  }
  return out;
}
