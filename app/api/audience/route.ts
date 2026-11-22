import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { logAudience } from "@/app/lib/b2b-activity";
import { normalizeCond, isEmptyCond, condSummary, condLines, findAudience, loadContacts, listChannels, listProducts, listOrderNames, maskName, maskPhone, MAX_AUDIENCE } from "@/app/lib/audience";
import { loadTallyExclusion, dropResponders, type TallyStat } from "@/app/lib/audience-tally";
import { getTallyApiKey, listTallyForms } from "@/app/lib/voc-tally";
import { isSubCond, normalizeSubCond, isEmptySubCond, subSummary, subLines, findSubAudience, withContacts, listSubProducts, type SubCond } from "@/app/lib/audience-sub";
import { runSend, listSends, checkSendResult, normalizeVars, sendWindowOpen, isRequestId, SendError, NIGHT_MSG, MAX_SEND, type Recipient } from "@/app/lib/audience-send";
import { fetchAlimtalkTemplates, isSolapiConfigured, SolapiRejected, type AlimtalkTemplate } from "@/app/lib/solapi";
import { getRule, normalizePhone } from "@/app/lib/form-sms";
import type { AudienceCond } from "@/app/lib/audience";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 조회 제한 60초 + 연락처 읽기(고객 100명씩) + 엑셀 만들기 — 수만 명 추출에도 끊기지 않게

// 오디언스 추출 — 조건으로 고객을 찾고(검색), 이름·전화번호가 든 엑셀을 내려받는다(추출).
//  GET                         → 채널 선택지 + 검색·추출 기록(최근 100건)
//  GET ?products=1             → 상품 선택지(상품코드별 한 줄 + 주문서에 적힌 상품명별 한 줄, 주문 건수) — 화면이 상품 칸을 처음 누를 때 한 번
//  POST { action: "search", cond } → 인원·제외 인원·미리보기 10명(이름·번호 가림). 기록에 남는다.
//  POST { action: "export", cond } → 엑셀 파일(이름·전화번호·주문 횟수·누적 금액·첫/마지막 구매일 + 조건에 맞은 상품명·상품코드·주문 상품명·채널,
//                                    '추출 정보' 시트에 적용한 조건을 항목별로). 기록에 남는다.
//  POST { action: "export", cond, fromLog } → 기록의 조건으로 다시 추출. 같은 조건을 '지금 데이터'로 다시 조회하므로 인원은 그때와 다를 수 있다
//                                    (추출한 명단은 어디에도 저장하지 않는다). 다시 뽑은 것도 새 기록으로 남는다.
//  cond.mode = "sub" 이면 정기배송 고객(app/lib/audience-sub.ts) — 상태(품목 기준)·상품·회차·다음 결제 예정일·마지막 결제일·해지일. 흐름과 기록은 같다.
//  GET ?subproducts=1          → 정기배송 상품 선택지
//  GET ?forms=1                → 탈리 폼 선택지(응답자 빼기용) — 화면이 그 칸을 처음 누를 때 한 번
//  cond.excludeForms = 탈리 폼 응답자 빼기(app/lib/audience-tally.ts) — 검색·추출할 때마다 그 폼의 응답을 다시 읽어, 답한 고객을 뺀다(구매·정기배송 공통).
//                                    탈리를 읽지 못하면 오류로 끝낸다(빼지 못한 채 뽑지 않는다).
//  로그인한 내부 직원 누구나 쓸 수 있다(공장 계정 제외) — 대신 누가 언제 어떤 조건으로 몇 명을 봤는지 전부 화면에 보인다.
//
//  ■ 알림톡 보내기(2026-11-20, app/lib/audience-send.ts) — 내부 직원 누구나(대표 11-20: "모두가 보낼 수 있게", 공장 계정 제외). 대신 발송 기록이 모두에게 보인다. 정보성 알림톡·대체 발송 없음·즉시만·야간에는 보내지 않는다.
//  GET                         → 위에 더해 canSend(알림톡을 보낼 수 있는가 — 지금은 늘 true)·sends(알림톡 발송 기록 최근 50건, 표가 없으면 null)
//  GET ?templates=1            → 승인된 알림톡 템플릿(이름·본문·변수) + 지금 보낼 수 있는 시각인가
//  POST { action: "send", cond, requestId, templateId, vars, expected } → 조건으로 '지금' 다시 찾아(탈리 응답자 제외 포함) 그 고객에게 보낸다
//  POST { action: "test", requestId, templateId, vars, phone }         → 적은 번호 한 곳에 시험 발송(고객 이름 자리는 보내는 사람 이름)
//  POST { action: "send_result", id }                                  → 솔라피에 실제 결과(수신 완료·실패)를 물어 기록에 적는다

async function loginName(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get("b2b_auth")?.value;
  const sess = await verifySessionFull(t);
  if (sess) return sess.role === "factory" ? null : sess.name;
  return resolveUserName(t) || null;
}
// 보낼 수 있는 템플릿 = 카카오 검수를 통과한 것(상태 값이 없는 응답이면 막지 않는다 — 솔라피가 발송 때 다시 거른다)
const usable = (t: AlimtalkTemplate) => !t.status || t.status.toUpperCase() === "APPROVED";
const subCondError = (c: SubCond): string | null => {
  if (isEmptySubCond(c)) return "조건을 하나 이상 입력하세요.";
  if (c.lastPaidFrom && c.lastPaidTo && c.lastPaidFrom > c.lastPaidTo) return "마지막 결제일의 시작일이 종료일보다 뒤입니다.";
  if (c.termFrom && c.termTo && c.termFrom > c.termTo) return "해지일의 시작일이 종료일보다 뒤입니다.";
  if (c.payFrom && c.payTo && c.payFrom > c.payTo) return "다음 결제 예정일의 시작일이 종료일보다 뒤입니다.";
  if (c.minRound && c.maxRound && c.minRound > c.maxRound) return "회차의 최소가 최대보다 큽니다.";
  return null;
};
const buyCondError = (c: AudienceCond): string | null => {
  if (isEmptyCond(c)) return "조건을 하나 이상 입력하세요.";
  if (c.from && c.to && c.from > c.to) return "구매 기간의 시작일이 종료일보다 뒤입니다.";
  if (c.lastFrom && c.lastTo && c.lastFrom > c.lastTo) return "마지막 구매일의 시작일이 종료일보다 뒤입니다.";
  if (c.minOrders && c.maxOrders && c.minOrders > c.maxOrders) return "주문 횟수의 최소가 최대보다 큽니다.";
  return null;
};
const HISTORY_TYPES = ["sales.audience_search", "sales.audience_export"];
// 엑셀 '추출 정보'의 [제외] 줄에 붙이는 말
const tallyNote = (t: TallyStat | null): string => (t ? ` · 탈리 응답자 ${t.removed.toLocaleString("ko-KR")}명(응답 ${t.responses.toLocaleString("ko-KR")}건${t.noPhone ? `, 그중 전화번호 없는 응답 ${t.noPhone.toLocaleString("ko-KR")}건은 빼지 못함` : ""})` : "");
const kstStamp = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 16);

export async function GET(req: NextRequest) {
  try {
    const me = await loginName(req);
    if (!me) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const sb = supabaseAdmin();
    if (req.nextUrl.searchParams.get("templates") === "1") {
      if (!isSolapiConfigured()) return NextResponse.json({ ok: false, error: "솔라피 키가 설정되지 않았습니다." }, { status: 400 });
      const templates = (await fetchAlimtalkTemplates()).filter(usable).map((t) => ({ templateId: t.templateId, name: t.name, content: t.content, variables: t.variables }));
      return NextResponse.json({ ok: true, templates, open: sendWindowOpen(), nightMessage: NIGHT_MSG, max: MAX_SEND });
    }
    if (req.nextUrl.searchParams.get("forms") === "1") {
      const apiKey = await getTallyApiKey();
      if (!apiKey) return NextResponse.json({ ok: false, error: "탈리 API 키가 없습니다 — 관리자 › 설정 › 연결에서 Tally 키를 넣으세요." }, { status: 400 });
      return NextResponse.json({ ok: true, forms: await listTallyForms(apiKey) });
    }
    if (req.nextUrl.searchParams.get("subproducts") === "1") return NextResponse.json({ ok: true, products: await listSubProducts(sb) });
    if (req.nextUrl.searchParams.get("products") === "1") {
      const [products, names] = await Promise.all([listProducts(sb), listOrderNames(sb)]);
      return NextResponse.json({ ok: true, products, names });
    }
    const [channels, sends, hist] = await Promise.all([
      listChannels(sb).catch(() => [] as string[]),
      listSends(sb).catch((e) => { console.error("[audience] sends", e); return null; }),
      sb.from("activity_log").select("id, event_type, summary, meta, actor, created_at").in("event_type", HISTORY_TYPES).order("created_at", { ascending: false }).limit(100),
    ]);
    if (hist.error) throw hist.error;
    const history = ((hist.data ?? []) as { id: string | number; event_type: string; summary: string; meta: { count?: number; summary?: string; cond?: unknown; from_log?: string } | null; actor: string | null; created_at: string }[])
      .map((r) => ({ id: r.id, action: r.event_type === "sales.audience_export" ? "추출" : "검색", cond: r.meta?.summary || r.summary, count: r.meta?.count ?? null, actor: r.actor, created_at: r.created_at,
        again: !!r.meta?.from_log,            // 예전 기록의 조건으로 다시 추출한 줄
        saved: r.meta?.cond ?? null }));     // 그때의 조건(전화번호·이름 없음) — [다시 추출]이 이 조건을 그대로 보낸다
    return NextResponse.json({ ok: true, channels, history, sends, canSend: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "오디언스 기록을 불러오지 못했습니다") }, { status: 500 });
  }
}

// ── 정기배송 고객 ──
async function handleSub(action: "search" | "export", raw: unknown, name: string, fromLog: string | null): Promise<NextResponse> {
  const cond = normalizeSubCond(raw);
  const bad = subCondError(cond);
  if (bad) return NextResponse.json({ ok: false, error: bad }, { status: 400 });

  const sb = supabaseAdmin();
  const summary = subSummary(cond);
  const found = await findSubAudience(sb, cond);
  let tally: TallyStat | null = null;
  if (cond.excludeForms?.length) {
    const ex = await loadTallyExclusion(cond.excludeForms);
    const d = dropResponders(found.rows, ex);
    found.rows = d.rows;
    tally = { forms: cond.excludeForms.map((f) => f.name), responses: ex.responses, noPhone: ex.noPhone, removed: d.removed };
  }
  const { list, excluded } = await withContacts(sb, found.rows);

  if (action === "export") {
    if (!list.length) return NextResponse.json({ ok: false, error: "조건에 맞는 고객이 없습니다." }, { status: 400 });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("오디언스");
    ws.columns = [
      { header: "이름", key: "name", width: 14 }, { header: "전화번호", key: "phone", width: 16 }, { header: "사람 기준 상태", key: "person", width: 14 }, { header: "품목 상태", key: "states", width: 18 }, { header: "일시정지 구분", key: "pause_kind", width: 14 },
      { header: "회차", key: "round", width: 8 }, { header: "다음 결제 예정일", key: "next_pay", width: 16 }, { header: "마지막 결제일", key: "last_paid", width: 14 }, { header: "해지일", key: "terminated", width: 12 },
      { header: "상품명", key: "items", width: 40 }, { header: "상품코드", key: "codes", width: 24 }, { header: "신청번호", key: "sub_ids", width: 26 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getColumn("phone").numFmt = "@"; // 글자로 — 맨 앞 0 이 사라지지 않게
    for (const { row: r, contact: c } of list)
      ws.addRow({ name: c.name, phone: c.phone, person: r.person, states: r.states, pause_kind: r.pause_kind, round: r.round ?? "", next_pay: r.next_pay ?? "", last_paid: r.last_paid ?? "", terminated: r.terminated ?? "", items: r.items, codes: r.codes, sub_ids: r.sub_ids });
    const info = wb.addWorksheet("추출 정보");
    info.columns = [{ width: 20 }, { width: 90 }];
    info.addRows([
      ["인원", list.length], ["추출한 사람", name], ["추출 시각", kstStamp()],
      ["제외", `번호를 못 찾은 신청 ${found.unlinked.toLocaleString("ko-KR")}건 · 안심번호(050)·번호 없는 고객 ${excluded.toLocaleString("ko-KR")}명${tallyNote(tally)}`],
      [], ["적용한 조건", ""], ...subLines(cond),
      [], ["칸 설명", ""],
      ["사람 기준 상태", "그 고객의 모든 신청·품목을 통틀어 — 이용 중인 품목이 하나라도 있으면 이용중, 이용 중인 품목은 없고 일시정지한 품목이 있으면 일시정지, 전부 해지면 해지. 전날 밤 카페24에서 가져온 값"],
      ["품목 상태", "그 고객이 가진 품목들의 상태(품목마다 달라 여러 개일 수 있다)"],
      ["일시정지 구분", "전체 일시정지 = 일시정지한 품목이 있고 이용 중인 품목이 하나도 없음 / 부분 일시정지 = 일시정지한 품목과 이용 중인 품목이 함께 있음"],
      ["회차·결제 예정일", "조건에 맞은 신청 기준. 신청이 여러 개면 회차는 큰 값, 결제 예정일은 빠른 날"],
      ["상품명·상품코드", "조건(상태·상품)에 맞은 품목의 것. 사람 기준이면 그 사람의 상태와 같은 상태인 품목"],
      ["마지막 결제일", "결제가 완료된 마지막 날. 일시정지한 날은 카페24가 주지 않아, 쉰 지 얼마나 됐는지는 이 날짜로 본다"],
      ["번호를 못 찾은 신청", "결제 주문이 매출 원장에 없어 고객 전화번호와 잇지 못한 신청"],
    ]);
    info.getColumn(1).font = { bold: true };
    info.getColumn(2).alignment = { wrapText: true, vertical: "top" };
    const buf = await wb.xlsx.writeBuffer();
    await logAudience("export", summary, list.length, name, cond as unknown as Record<string, unknown>, fromLog);
    const file = `오디언스_정기배송_${kstStamp().slice(0, 10).replace(/-/g, "")}_${list.length}명.xlsx`;
    return new NextResponse(Buffer.from(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="audience.xlsx"; filename*=UTF-8''${encodeURIComponent(file)}`,
        "X-Audience-Count": String(list.length),
        "Cache-Control": "no-store",
      },
    });
  }

  const preview = list.slice(0, 10).map(({ row: r, contact: c }) => ({ name: maskName(c.name), phone: maskPhone(c.phone), person: r.person, states: r.states, round: r.round, next_pay: r.next_pay, last_paid: r.last_paid, terminated: r.terminated, items: r.items }));
  await logAudience("search", summary, list.length, name, cond as unknown as Record<string, unknown>);
  return NextResponse.json({ ok: true, count: list.length, excluded, unlinked: found.unlinked, subs: found.subs, capped: found.capped, max: MAX_AUDIENCE, summary, preview, tally });
}

// ── 알림톡 보내기 ──
// 받을 사람 — 조건으로 '지금' 다시 찾는다(탈리 응답자 제외도 지금 응답으로). 휴대폰 번호가 아닌 번호는 알림톡이 가지 않아 뺀다.
async function findRecipients(raw: unknown): Promise<{ mode: "buy" | "sub"; cond: Record<string, unknown>; summary: string; recipients: Recipient[]; notMobile: number }> {
  const sb = supabaseAdmin();
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  let notMobile = 0;
  const add = (name: string | undefined, phone: string | undefined) => {
    const p = normalizePhone(phone);
    if (!p) { notMobile++; return; }
    if (seen.has(p)) return;
    seen.add(p); recipients.push({ phone: p, name: (name || "").trim() });
  };
  if (isSubCond(raw)) {
    const cond = normalizeSubCond(raw);
    const bad = subCondError(cond);
    if (bad) throw new SendError(bad);
    const found = await findSubAudience(sb, cond);
    if (cond.excludeForms?.length) found.rows = dropResponders(found.rows, await loadTallyExclusion(cond.excludeForms)).rows;
    const { list } = await withContacts(sb, found.rows);
    for (const { contact } of list) add(contact.name, contact.phone);
    return { mode: "sub", cond: cond as unknown as Record<string, unknown>, summary: subSummary(cond), recipients, notMobile };
  }
  const cond = normalizeCond(raw);
  const bad = buyCondError(cond);
  if (bad) throw new SendError(bad);
  const found = await findAudience(sb, cond);
  if (cond.excludeForms?.length) found.rows = dropResponders(found.rows, await loadTallyExclusion(cond.excludeForms)).rows;
  const contacts = await loadContacts(sb, found.rows.map((r) => r.customer_key));
  for (const r of found.rows) { const c = contacts.get(r.customer_key); if (c?.phone) add(c.name, c.phone); }
  return { mode: "buy", cond: cond as Record<string, unknown>, summary: condSummary(cond), recipients, notMobile };
}

type SendBody = { action?: string; cond?: unknown; requestId?: unknown; templateId?: unknown; vars?: unknown; expected?: unknown; phone?: unknown; id?: unknown };
async function handleSend(b: SendBody, name: string): Promise<NextResponse> {
  if (!isSolapiConfigured()) return NextResponse.json({ ok: false, error: "솔라피 키가 설정되지 않았습니다." }, { status: 400 });
  const sb = supabaseAdmin();
  if (b.action === "send_result") {
    const id = Math.floor(Number(b.id));
    if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ ok: false, error: "발송 기록을 찾지 못했습니다." }, { status: 400 });
    return NextResponse.json({ ok: true, row: await checkSendResult(sb, id) });
  }
  if (!sendWindowOpen()) return NextResponse.json({ ok: false, error: NIGHT_MSG }, { status: 400 });
  if (!isRequestId(b.requestId)) return NextResponse.json({ ok: false, error: "발송 요청 번호가 없습니다. 창을 닫고 다시 여세요." }, { status: 400 });
  const template = (await fetchAlimtalkTemplates()).find((t) => t.templateId === String(b.templateId || ""));
  if (!template) return NextResponse.json({ ok: false, error: "템플릿을 찾지 못했습니다." }, { status: 400 });
  if (!usable(template)) return NextResponse.json({ ok: false, error: "카카오 검수를 통과하지 않은 템플릿입니다." }, { status: 400 });
  const vars = normalizeVars(b.vars, template.variables);
  // 신청자 문자에 등록한 발신번호(있으면 붙인다). 대체 발송은 꺼져 있어 문자는 나가지 않는다
  const from = await getRule().then((r) => r.from.replace(/\D/g, "") || undefined).catch(() => undefined);

  if (b.action === "test") {
    const phone = normalizePhone(b.phone);
    if (!phone) return NextResponse.json({ ok: false, error: "시험 발송할 휴대폰 번호를 확인하세요." }, { status: 400 });
    const out = await runSend(sb, { requestId: b.requestId, kind: "test", mode: "test", cond: null, summary: "시험 발송", template, vars, recipients: [{ phone, name }], by: name, from });
    return NextResponse.json({ ok: true, ...out });
  }

  const found = await findRecipients(b.cond);
  const expected = Math.floor(Number(b.expected));
  if (!found.recipients.length) return NextResponse.json({ ok: false, error: "조건에 맞는 고객이 없습니다." }, { status: 400 });
  // 화면에서 확인한 인원보다 눈에 띄게 늘었으면 보내지 않는다 — 확인하지 않은 사람에게 나가는 일을 막는다
  if (Number.isFinite(expected) && expected > 0 && found.recipients.length > expected * 1.1 + 5)
    return NextResponse.json({ ok: false, error: `찾은 뒤 인원이 ${found.recipients.length.toLocaleString("ko-KR")}명으로 늘었습니다. [고객 찾기]를 다시 누르고 확인한 뒤 보내세요.` }, { status: 409 });
  const out = await runSend(sb, { requestId: b.requestId, kind: "send", mode: found.mode, cond: found.cond, summary: found.summary, template, vars, recipients: found.recipients, by: name, from });
  return NextResponse.json({ ok: true, ...out, notMobile: found.notMobile });
}

export async function POST(req: NextRequest) {
  try {
    const name = await loginName(req);
    if (!name) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const b = (await req.json().catch(() => ({}))) as SendBody & { fromLog?: string | number };
    if (b.action === "send" || b.action === "test" || b.action === "send_result") return await handleSend(b, name);
    const fromLog = b.fromLog != null && /^[A-Za-z0-9-]{1,64}$/.test(String(b.fromLog)) ? String(b.fromLog) : null;
    if (isSubCond(b.cond)) return await handleSub(b.action === "export" ? "export" : "search", b.cond, name, fromLog);
    const cond = normalizeCond(b.cond);
    const bad = buyCondError(cond);
    if (bad) return NextResponse.json({ ok: false, error: bad }, { status: 400 });

    const sb = supabaseAdmin();
    const summary = condSummary(cond);
    const found = await findAudience(sb, cond);
    let tally: TallyStat | null = null;
    if (cond.excludeForms?.length) {
      const ex = await loadTallyExclusion(cond.excludeForms);
      const d = dropResponders(found.rows, ex);
      found.rows = d.rows;
      tally = { forms: cond.excludeForms.map((f) => f.name), responses: ex.responses, noPhone: ex.noPhone, removed: d.removed };
    }

    if (b.action === "export") {
      if (!found.rows.length) return NextResponse.json({ ok: false, error: "조건에 맞는 고객이 없습니다." }, { status: 400 });
      const contacts = await loadContacts(sb, found.rows.map((r) => r.customer_key));
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("오디언스");
      ws.columns = [
        { header: "이름", key: "name", width: 14 }, { header: "전화번호", key: "phone", width: 16 }, { header: "주문 횟수", key: "orders", width: 10 },
        { header: "누적 구매 금액", key: "amount", width: 16 }, { header: "첫 구매일", key: "first", width: 12 }, { header: "마지막 구매일", key: "last", width: 12 },
        // 아래 네 칸 = 조건(구매 기간·채널·상품)에 맞은 주문의 것 — 이 고객이 왜 뽑혔는지
        { header: "상품명", key: "items", width: 36 }, { header: "상품코드", key: "codes", width: 24 }, { header: "주문 상품명", key: "order_names", width: 48 }, { header: "채널", key: "channels", width: 16 },
      ];
      ws.getRow(1).font = { bold: true };
      ws.getColumn("phone").numFmt = "@"; // 글자로 — 맨 앞 0 이 사라지지 않게
      ws.getColumn("amount").numFmt = "#,##0";
      let n = 0;
      for (const r of found.rows) {
        const c = contacts.get(r.customer_key);
        if (!c?.phone) continue;
        ws.addRow({ name: c.name, phone: c.phone, orders: r.orders, amount: r.amount, first: r.first_date, last: r.last_date, items: r.items, codes: r.codes, order_names: r.order_names, channels: r.channels });
        n++;
      }
      const info = wb.addWorksheet("추출 정보");
      info.columns = [{ width: 20 }, { width: 90 }];
      info.addRows([
        ["인원", n], ["추출한 사람", name], ["추출 시각", kstStamp()], ["제외", `안심번호(050)·번호 없는 고객 ${found.excluded.toLocaleString("ko-KR")}명${tallyNote(tally)}`],
        [], ["적용한 조건", ""], ...condLines(cond),
        [], ["칸 설명", ""],
        ["상품명·상품코드·주문 상품명·채널", "조건(구매 기간·채널·상품)에 맞은 주문에서 가져온 값. 상품 조건이 없으면 그 기간·채널에 산 상품 전부"],
        ["주문 횟수·누적 구매 금액·첫/마지막 구매일", cond.channels?.length ? `고른 채널(${cond.channels.join(", ")})의 주문 기준 — 다른 채널 주문은 세지 않는다. 구매 기간과 상관없이 그 채널의 전체 주문` : "그 고객의 전체 주문 기준(모든 채널)"],
      ]);
      info.getColumn(1).font = { bold: true };
      info.getColumn(2).alignment = { wrapText: true, vertical: "top" };
      const buf = await wb.xlsx.writeBuffer();
      await logAudience("export", summary, n, name, cond as Record<string, unknown>, fromLog);
      const file = `오디언스_${kstStamp().slice(0, 10).replace(/-/g, "")}_${n}명.xlsx`;
      return new NextResponse(Buffer.from(buf), { // 다른 엑셀 내려받기(b2b/orders/export-shipping)와 같은 방식
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="audience.xlsx"; filename*=UTF-8''${encodeURIComponent(file)}`,
          "X-Audience-Count": String(n),
          "Cache-Control": "no-store",
        },
      });
    }

    // 검색 — 인원과 미리보기 10명(가려서)
    const head = found.rows.slice(0, 10);
    const contacts = await loadContacts(sb, head.map((r) => r.customer_key));
    const preview = head.map((r) => { const c = contacts.get(r.customer_key); return { name: maskName(c?.name || ""), phone: maskPhone(c?.phone || ""), orders: r.orders, amount: r.amount, first_date: r.first_date, last_date: r.last_date, items: r.items, codes: r.codes, channels: r.channels }; });
    await logAudience("search", summary, found.rows.length, name, cond as Record<string, unknown>);
    return NextResponse.json({ ok: true, count: found.rows.length, excluded: found.excluded, capped: found.capped, max: MAX_AUDIENCE, summary, preview, tally });
  } catch (err) {
    if (err instanceof SendError) return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    if (err instanceof SolapiRejected) return NextResponse.json({ ok: false, error: err.message }, { status: 502 });
    console.error("[audience]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "고객을 찾지 못했습니다") }, { status: 500 });
  }
}
