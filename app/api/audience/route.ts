import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { logAudience } from "@/app/lib/b2b-activity";
import { normalizeCond, isEmptyCond, condSummary, condLines, findAudience, loadContacts, listChannels, listProducts, listOrderNames, maskName, maskPhone, MAX_AUDIENCE } from "@/app/lib/audience";
import { isSubCond, normalizeSubCond, isEmptySubCond, subSummary, subLines, findSubAudience, withContacts, listSubProducts } from "@/app/lib/audience-sub";

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
//  cond.mode = "sub" 이면 정기배송 고객(app/lib/audience-sub.ts) — 상태·상태 바뀐 날·회차·다음 결제 예정일·상품. 흐름과 기록은 같다.
//  GET ?subproducts=1          → 정기배송 상품 선택지
//  로그인한 내부 직원 누구나 쓸 수 있다(공장 계정 제외) — 대신 누가 언제 어떤 조건으로 몇 명을 봤는지 전부 화면에 보인다.

async function loginName(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get("b2b_auth")?.value;
  const sess = await verifySessionFull(t);
  if (sess) return sess.role === "factory" ? null : sess.name;
  return resolveUserName(t) || null;
}
const HISTORY_TYPES = ["sales.audience_search", "sales.audience_export"];
const kstStamp = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 16);

export async function GET(req: NextRequest) {
  try {
    if (!(await loginName(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const sb = supabaseAdmin();
    if (req.nextUrl.searchParams.get("subproducts") === "1") return NextResponse.json({ ok: true, products: await listSubProducts(sb) });
    if (req.nextUrl.searchParams.get("products") === "1") {
      const [products, names] = await Promise.all([listProducts(sb), listOrderNames(sb)]);
      return NextResponse.json({ ok: true, products, names });
    }
    const [channels, hist] = await Promise.all([
      listChannels(sb).catch(() => [] as string[]),
      sb.from("activity_log").select("id, event_type, summary, meta, actor, created_at").in("event_type", HISTORY_TYPES).order("created_at", { ascending: false }).limit(100),
    ]);
    if (hist.error) throw hist.error;
    const history = ((hist.data ?? []) as { id: string | number; event_type: string; summary: string; meta: { count?: number; summary?: string; cond?: unknown; from_log?: string } | null; actor: string | null; created_at: string }[])
      .map((r) => ({ id: r.id, action: r.event_type === "sales.audience_export" ? "추출" : "검색", cond: r.meta?.summary || r.summary, count: r.meta?.count ?? null, actor: r.actor, created_at: r.created_at,
        again: !!r.meta?.from_log,            // 예전 기록의 조건으로 다시 추출한 줄
        saved: r.meta?.cond ?? null }));     // 그때의 조건(전화번호·이름 없음) — [다시 추출]이 이 조건을 그대로 보낸다
    return NextResponse.json({ ok: true, channels, history });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "오디언스 기록을 불러오지 못했습니다") }, { status: 500 });
  }
}

// ── 정기배송 고객 ──
async function handleSub(action: "search" | "export", raw: unknown, name: string, fromLog: string | null): Promise<NextResponse> {
  const cond = normalizeSubCond(raw);
  if (isEmptySubCond(cond)) return NextResponse.json({ ok: false, error: "조건을 하나 이상 입력하세요." }, { status: 400 });
  if (cond.changedFrom && cond.changedTo && cond.changedFrom > cond.changedTo) return NextResponse.json({ ok: false, error: "상태 바뀐 날의 시작일이 종료일보다 뒤입니다." }, { status: 400 });
  if (cond.payFrom && cond.payTo && cond.payFrom > cond.payTo) return NextResponse.json({ ok: false, error: "다음 결제 예정일의 시작일이 종료일보다 뒤입니다." }, { status: 400 });
  if (cond.minRound && cond.maxRound && cond.minRound > cond.maxRound) return NextResponse.json({ ok: false, error: "회차의 최소가 최대보다 큽니다." }, { status: 400 });

  const sb = supabaseAdmin();
  const summary = subSummary(cond);
  const found = await findSubAudience(sb, cond);
  const { list, excluded } = await withContacts(sb, found.rows);

  if (action === "export") {
    if (!list.length) return NextResponse.json({ ok: false, error: "조건에 맞는 고객이 없습니다." }, { status: 400 });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("오디언스");
    ws.columns = [
      { header: "이름", key: "name", width: 14 }, { header: "전화번호", key: "phone", width: 16 }, { header: "정기배송 상태", key: "states", width: 14 },
      { header: "회차", key: "round", width: 8 }, { header: "다음 결제 예정일", key: "next_pay", width: 16 }, { header: "상태 바뀐 날", key: "changed_on", width: 14 },
      { header: "상품명", key: "items", width: 40 }, { header: "상품코드", key: "codes", width: 24 }, { header: "신청번호", key: "sub_ids", width: 26 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getColumn("phone").numFmt = "@"; // 글자로 — 맨 앞 0 이 사라지지 않게
    for (const { row: r, contact: c } of list)
      ws.addRow({ name: c.name, phone: c.phone, states: r.states, round: r.round ?? "", next_pay: r.next_pay ?? "", changed_on: r.changed_on ?? "", items: r.items, codes: r.codes, sub_ids: r.sub_ids });
    const info = wb.addWorksheet("추출 정보");
    info.columns = [{ width: 20 }, { width: 90 }];
    info.addRows([
      ["인원", list.length], ["추출한 사람", name], ["추출 시각", kstStamp()],
      ["제외", `번호를 못 찾은 신청 ${found.unlinked.toLocaleString("ko-KR")}건 · 안심번호(050)·번호 없는 고객 ${excluded.toLocaleString("ko-KR")}명`],
      [], ["적용한 조건", ""], ...subLines(cond),
      [], ["칸 설명", ""],
      ["정기배송 상태·회차·상품", "전날 밤 카페24에서 가져온 값. 한 고객이 신청을 여러 개 가지면 한 줄로 묶는다(회차는 큰 값, 결제 예정일은 빠른 날)"],
      ["상태 바뀐 날", "일시정지한 날·재개한 날은 2026-10-08 이후에 바뀐 것만 안다(그 전은 빈칸). 해지한 날은 전부 안다"],
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

  const preview = list.slice(0, 10).map(({ row: r, contact: c }) => ({ name: maskName(c.name), phone: maskPhone(c.phone), states: r.states, round: r.round, next_pay: r.next_pay, changed_on: r.changed_on, items: r.items }));
  await logAudience("search", summary, list.length, name, cond as unknown as Record<string, unknown>);
  return NextResponse.json({ ok: true, count: list.length, excluded, unlinked: found.unlinked, subs: found.subs, capped: found.capped, noLog: found.noLog, max: MAX_AUDIENCE, summary, preview });
}

export async function POST(req: NextRequest) {
  try {
    const name = await loginName(req);
    if (!name) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const b = (await req.json().catch(() => ({}))) as { action?: string; cond?: unknown; fromLog?: string | number };
    const fromLog = b.fromLog != null && /^[A-Za-z0-9-]{1,64}$/.test(String(b.fromLog)) ? String(b.fromLog) : null;
    if (isSubCond(b.cond)) return await handleSub(b.action === "export" ? "export" : "search", b.cond, name, fromLog);
    const cond = normalizeCond(b.cond);
    if (isEmptyCond(cond)) return NextResponse.json({ ok: false, error: "조건을 하나 이상 입력하세요." }, { status: 400 });
    if (cond.from && cond.to && cond.from > cond.to) return NextResponse.json({ ok: false, error: "구매 기간의 시작일이 종료일보다 뒤입니다." }, { status: 400 });
    if (cond.lastFrom && cond.lastTo && cond.lastFrom > cond.lastTo) return NextResponse.json({ ok: false, error: "마지막 구매일의 시작일이 종료일보다 뒤입니다." }, { status: 400 });
    if (cond.minOrders && cond.maxOrders && cond.minOrders > cond.maxOrders) return NextResponse.json({ ok: false, error: "주문 횟수의 최소가 최대보다 큽니다." }, { status: 400 });

    const sb = supabaseAdmin();
    const summary = condSummary(cond);
    const found = await findAudience(sb, cond);

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
        ["인원", n], ["추출한 사람", name], ["추출 시각", kstStamp()], ["제외", `안심번호(050)·번호 없는 고객 ${found.excluded.toLocaleString("ko-KR")}명`],
        [], ["적용한 조건", ""], ...condLines(cond),
        [], ["칸 설명", ""],
        ["상품명·상품코드·주문 상품명·채널", "조건(구매 기간·채널·상품)에 맞은 주문에서 가져온 값. 상품 조건이 없으면 그 기간·채널에 산 상품 전부"],
        ["주문 횟수·누적 구매 금액·첫/마지막 구매일", "그 고객의 전체 주문 기준"],
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
    return NextResponse.json({ ok: true, count: found.rows.length, excluded: found.excluded, capped: found.capped, max: MAX_AUDIENCE, summary, preview });
  } catch (err) {
    console.error("[audience]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "고객을 찾지 못했습니다") }, { status: 500 });
  }
}
