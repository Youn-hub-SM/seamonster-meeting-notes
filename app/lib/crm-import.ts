// CRM 메시지 엑셀 가져오기(서버 전용) — public/templates/crm-messages-template.xlsx 양식의 '메시지' 시트를 crm_messages 로.
//  2026-11-06. 규칙: 한 줄 = 메시지 하나, 같은 메시지명은 덮어쓴다(뒤 줄 우선), 빨간 칸(메시지명·발송 수단·트리거·본문)이 비면 그 줄은 건너뛴다.
//  UTM 은 app/lib/utm-rules.ts 의 checkCrmRow 로 줄마다 검사 — 어긋나면 경고(등록은 됨), http·빈 캠페인/매체 칸은 자동 보정.
import ExcelJS from "exceljs";
import { CRM_TRIGGERS, EMPTY_CRM_MESSAGE, normalizeCrmMessage, statusKey, type CrmMessage, type CrmMessageInput, type CrmOption, type CrmOptions } from "./crm";
import { CRM_MEDIUM_VALUES, checkCrmRow, isTrackedUrl, parseUtm, type CrmMediumExtra } from "./utm-rules";

export type ImportRowReport = {
  row: number;            // 엑셀 행 번호
  title: string;
  stage: string;
  action: "insert" | "update" | "skip";
  errors: string[];       // 건너뛰는 이유
  warnings: string[];     // 등록은 되지만 봐야 할 것
  fixes: string[];        // 자동 보정한 것
};
export type ImportPlan = {
  items: { report: ImportRowReport; input: CrmMessageInput; existingId?: string }[];
  newStages: string[];
  newOptions: { channels: CrmOption[]; customers: CrmOption[]; msgTypes: CrmOption[] };
  counts: { insert: number; update: number; skip: number };
};

// 양식 열 이름(머리글 그대로) — 순서가 바뀌어도 이름으로 찾는다
const COL = {
  stage: "단계", title: "메시지명", customer: "고객군", channel: "발송 수단", msgType: "유형", trigger: "트리거", offset: "D+n",
  note: "조건 메모", timing: "발송 시점 설명", status: "상태", msg: "본문", urls: "링크 URL", campaign: "UTM 캠페인", medium: "UTM 매체",
  solapi: "솔라피 템플릿 ID", ctr: "목표 클릭률(%)", start: "시작일", end: "종료일", tags: "태그·메모",
} as const;

// 양식 선택지 라벨 → 저장 키. 선택지 표(b2b_settings crm_options)에 있으면 그 키, 없으면 아래 기본, 그래도 없으면 라벨 그대로(한글 키 허용)
const CHANNEL_KEYS: Record<string, string> = { "솔라피": "solapi", "카카오": "kakao", "카페24": "cafe24", "블룸ai": "bloomai", "블룸 ai": "bloomai", "데이터라이즈": "datarize", "알리고 문자": "aligo", "네이버 톡톡": "navertalk", "톡스토어": "talkstore", "이메일": "email", "기타": "etc" };
const CUSTOMER_KEYS: Record<string, string> = { "네이버": "naver", "공식몰": "mall", "기타": "etc" };
const MSG_TYPE_KEYS: Record<string, string> = { "알림톡": "alimtalk", "친구톡": "friendtalk", "브랜드메시지": "brandmessage", "문자": "sms", "톡톡": "talktalk", "이메일": "email", "기타": "etc" };

const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; text?: string; result?: unknown; hyperlink?: string };
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (o.text != null) return String(o.text);
    if (o.result != null) return cellText(o.result as ExcelJS.CellValue);
    if (o.hyperlink) return String(o.hyperlink);
    return "";
  }
  return String(v);
};
// 엑셀 시각 셀(1899-12-30T19:00Z) → "19:00 발송", 날짜 셀 → YYYY-MM-DD
const isoTimeToText = (s: string): string => { const m = s.match(/^1899-12-3[01]T(\d{2}):(\d{2})/); return m ? `${m[1]}:${m[2]} 발송` : s; };
const toYmd = (s: string): string => { const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : ""; };

function pickKey(label: string, opts: CrmOption[], defaults: Record<string, string>): { key: string; isNew: boolean; option: CrmOption } {
  const l = label.trim();
  const hit = opts.find((o) => o.label.trim().toLowerCase() === l.toLowerCase() || o.key.toLowerCase() === l.toLowerCase());
  if (hit) return { key: hit.key, isNew: false, option: hit };
  const key = defaults[l.toLowerCase()] ?? defaults[l] ?? l;
  return { key, isNew: true, option: { key, label: l } };
}

export async function readCrmWorkbook(buf: ArrayBuffer | Buffer): Promise<{ header: string[]; rows: { row: number; cells: Record<string, string> }[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]); // exceljs 타입이 옛 Buffer 라 캐스팅(products/import 와 같음)
  const ws = wb.getWorksheet("메시지") ?? wb.worksheets[0];
  if (!ws) throw new Error("'메시지' 시트가 없습니다. 양식 파일을 그대로 쓰세요");
  const header = ((ws.getRow(1).values as ExcelJS.CellValue[]) ?? []).slice(1).map((v) => cellText(v).trim());
  if (!header.includes(COL.title)) throw new Error("머리글에 '메시지명' 열이 없습니다. 양식의 1행을 바꾸지 마세요");
  const rows: { row: number; cells: Record<string, string> }[] = [];
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const cells: Record<string, string> = {};
    ((row.values as ExcelJS.CellValue[]) ?? []).slice(1).forEach((v, j) => { const h = header[j]; if (h) cells[h] = cellText(v).trim(); });
    if (Object.values(cells).some(Boolean)) rows.push({ row: i, cells });
  });
  return { header, rows };
}

export function planCrmImport(
  rows: { row: number; cells: Record<string, string> }[],
  ctx: { existing: Pick<CrmMessage, "id" | "title" | "stage" | "stage_num">[]; options: CrmOptions; mediaExtra: CrmMediumExtra[]; replace: boolean }
): ImportPlan {
  const allowedMedia = [...CRM_MEDIUM_VALUES, ...ctx.mediaExtra.map((m) => m.value)];
  const stageNum = new Map<string, number>();
  if (!ctx.replace) for (const e of ctx.existing) if (e.stage && !stageNum.has(e.stage)) stageNum.set(e.stage, e.stage_num);
  let nextStage = Math.max(0, ...stageNum.values()) + 1;
  const newStages: string[] = [];
  const sortSeq = new Map<string, number>();
  const byTitle = new Map<string, string>(); // 기존 메시지명 → id (중복이면 첫 것)
  if (!ctx.replace) for (const e of ctx.existing) { const t = e.title.trim(); if (t && !byTitle.has(t)) byTitle.set(t, e.id); }
  const newOptions: ImportPlan["newOptions"] = { channels: [], customers: [], msgTypes: [] };
  const noteNew = (list: CrmOption[], o: CrmOption) => { if (!list.some((x) => x.key === o.key)) list.push(o); };
  const seenTitles = new Map<string, number>(); // 파일 안 중복 → 뒤 줄이 덮어쓴다(앞 줄은 skip)
  const items: ImportPlan["items"] = [];

  for (const r of rows) {
    const c = (k: keyof typeof COL) => r.cells[COL[k]] ?? "";
    const report: ImportRowReport = { row: r.row, title: c("title"), stage: c("stage"), action: "insert", errors: [], warnings: [], fixes: [] };
    const title = c("title");
    if (!title) report.errors.push("메시지명이 비어 있습니다");
    if (!c("channel")) report.errors.push("발송 수단이 비어 있습니다");
    if (!c("msg")) report.errors.push("본문이 비어 있습니다");
    // 트리거
    const trigLabel = c("trigger");
    const norm = (v: string) => v.replace(/\s+/g, "");
    let trig = CRM_TRIGGERS.find((t) => norm(t.label) === norm(trigLabel) || t.key === trigLabel);
    if (!trigLabel) report.errors.push("트리거가 비어 있습니다");
    else if (!trig) report.errors.push(`트리거 '${trigLabel}' 은 선택지에 없습니다 (${CRM_TRIGGERS.map((t) => t.label).join("/")})`);
    // 상시로 적었는데 조건 메모 첫 줄이 사건 이름이면 그 트리거로(네이버 솔라피 줄: 결제완료·구매확정·배송중·배송완료)
    if (trig?.key === "always") {
      const first = norm(c("note").split(/\r?\n/)[0] ?? "");
      const byNote = CRM_TRIGGERS.find((t) => t.key !== "always" && first.startsWith(norm(t.label))) ?? (first.startsWith("배송중") ? CRM_TRIGGERS.find((t) => t.key === "shipped") : undefined);
      if (byNote) { trig = byNote; report.fixes.push(`조건 메모 '${c("note").split(/\r?\n/)[0]}' 로 트리거를 '${byNote.label}' 로 바꿈`); }
    }
    // D+n
    let offset: number | null = null;
    let offsetNote = c("note");
    const offRaw = c("offset");
    if (offRaw) {
      if (/^-?\d+$/.test(offRaw)) offset = parseInt(offRaw, 10);
      else { offsetNote = [offsetNote, `D+n: ${offRaw}`].filter(Boolean).join(" · "); report.fixes.push(`D+n '${offRaw}' 은 숫자가 아니라 조건 메모로 옮김`); }
      if (trig?.key === "always" && offset != null) { offsetNote = [offsetNote, `D+${offset}`].filter(Boolean).join(" · "); offset = null; report.fixes.push("상시 트리거라 D+n 을 조건 메모로 옮김"); }
    }
    // 선택지
    const ch = pickKey(c("channel"), ctx.options.channels, CHANNEL_KEYS);
    if (c("channel") && ch.isNew) noteNew(newOptions.channels, ch.option);
    const cu = c("customer") ? pickKey(c("customer"), ctx.options.customers, CUSTOMER_KEYS) : null;
    if (cu?.isNew) noteNew(newOptions.customers, cu.option);
    const mt = c("msgType") ? pickKey(c("msgType"), ctx.options.msgTypes, MSG_TYPE_KEYS) : null;
    if (mt?.isNew) noteNew(newOptions.msgTypes, mt.option);
    // 링크·UTM
    let urls = c("urls").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    let campaign = c("campaign").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? "";
    let medium = c("medium").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? "";
    const fixedUrls = urls.map((u) => (isTrackedUrl(u) && /^http:\/\//i.test(u) ? u.replace(/^http:\/\//i, "https://") : u));
    if (fixedUrls.some((u, i) => u !== urls[i])) { report.fixes.push("링크를 https 로 바꿈"); urls = fixedUrls; }
    const parsed = urls.filter(isTrackedUrl).map(parseUtm);
    if (!campaign) { const pc = parsed.find((p) => p.campaign)?.campaign; if (pc) { campaign = pc; report.fixes.push(`캠페인 칸을 링크의 ${pc} 로 채움`); } }
    if (!medium) { const pm = parsed.find((p) => p.medium)?.medium; if (pm) { medium = pm; report.fixes.push(`매체 칸을 링크의 ${pm} 로 채움`); } }
    const term = parsed.map((p) => p.term || "").find(Boolean) ?? "";
    if (campaign || medium || parsed.some((p) => p.hasUtm)) {
      for (const iss of checkCrmRow({ urls, campaign, medium }, { media: allowedMedia })) report.warnings.push(`UTM: ${iss.msg}`);
      const kind = mt?.key === "alimtalk" ? "alimtalk" : mt?.key === "brandmessage" ? "brandmessage" : "";
      const path = cu?.key === "mall" ? "cafe24" : cu?.key === "naver" ? "naver" : "";
      if (kind && path && medium && medium !== `${kind}-${path}`) report.warnings.push(`UTM: 유형·고객군으로는 ${kind}-${path} 인데 매체가 ${medium}`);
    }
    // 상태·날짜·수치
    const st = c("status");
    const status = st === "비활성" || st.toLowerCase() === "inactive" ? "inactive" : statusKey(st === "활성" ? "active" : st);
    const ctrRaw = c("ctr").replace(/[^\d.]/g, "");
    const stage = c("stage") || "(단계 없음)";
    if (!stageNum.has(stage)) { stageNum.set(stage, nextStage++); newStages.push(stage); }
    const sort = (sortSeq.get(stage) ?? 0) + 1; sortSeq.set(stage, sort);

    const input: CrmMessageInput = normalizeCrmMessage({
      ...EMPTY_CRM_MESSAGE,
      stage_num: stageNum.get(stage)!, stage, title,
      status, channel: ch.key, timing: isoTimeToText(c("timing")), msg: c("msg"),
      links: { url: urls.find(isTrackedUrl) ?? urls[0] ?? "", utm_campaign: campaign, urls, utm_term: term },
      tags: c("tags"), sort_order: sort, active: true,
      start_date: toYmd(c("start")), end_date: toYmd(c("end")),
      customer: cu?.key ?? "", msg_type: mt?.key ?? "",
      trigger: trig?.key ?? "", offset_days: offset, offset_note: offsetNote, target_ctr: ctrRaw ? Number(ctrRaw) : null,
      solapi_template_id: c("solapi"), utm_medium: medium,
    });

    // 중복·기존 매칭
    const prev = seenTitles.get(title);
    if (title && prev != null) { const p = items.find((x) => x.report.row === prev); if (p) { p.report.action = "skip"; p.report.errors.push(`${r.row}행에 같은 메시지명이 있어 그 줄이 덮어씁니다`); } }
    if (title) seenTitles.set(title, r.row);
    const existingId = title ? byTitle.get(title) : undefined;
    if (report.errors.length) report.action = "skip";
    else report.action = existingId ? "update" : "insert";
    items.push({ report, input, existingId });
  }
  const counts = { insert: 0, update: 0, skip: 0 };
  for (const it of items) counts[it.report.action]++;
  return { items, newStages, newOptions, counts };
}
