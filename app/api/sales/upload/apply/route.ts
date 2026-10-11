import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { parseSalesFile } from "@/app/lib/sales-parse";
import { type SalesCustomerRow } from "@/app/lib/sales-normalize";
import { planUpload, planReplace, readUploadOptions, replaceBlockReason, uncoveredBlockReason } from "@/app/lib/sales-upload";
import { logSalesUpload, currentActor } from "@/app/lib/b2b-activity";
import { randomUUID } from "node:crypto";
import { kstDay, md } from "@/app/lib/analyst";
import { lastWeek, lastMonth, periodLabel } from "@/app/lib/analyst-period";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_APPLY = 50000;

// 파일 재파싱 → row_hash 멱등 upsert(중복 무시) + 고객 조회 테이블 병합 upsert.
//  옵션: dup_mode=separate(파일 안 동일 라인 따로 넣기) · replace=1 + replace_from/replace_to(기간 교체 — 미리보기가 보여 준 기간 필수)
//        · replace_widen=1(채널 파일 날짜 밖까지 교체 기간 전체로 지움) · confirm_uncovered=["채널|날짜",…](파일 행이 없거나 적은 날 삭제 확인)
//        · confirm_skip_invalid=1(오류 행 빼고 적용 — 기간 교체와 함께는 거절: 빠진 행의 기존 원장 행이 지워진다)
//        · expect_delete=N(미리보기 확인창의 지울 행 수 — 다시 계산한 수와 다르면 쓰기 전에 409).
//  미리보기와 같은 옵션을 보내야 같은 결과가 나온다(app/lib/sales-upload.ts 공용 계획).
//  쓰기 순서: 검증·교체 계획 확정 → 업로드 이력(실패면 멈춤) → 넣기 → 이력 건수('삭제 중' 표시) → 교체 삭제 → 이력 확정 → 고객.
//  넣기 뒤의 실패 경로도 응답 전에 이력(넣은 건수·지운 행 수)을 고친다 — 중간에 끊긴 업로드가 '신규 0'으로 남지 않게.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "파일이 첨부되지 않았습니다." }, { status: 400 });

    const { rows } = await parseSalesFile(file);
    if (rows.length === 0) return NextResponse.json({ ok: false, error: "행을 찾지 못했습니다." }, { status: 400 });
    if (rows.length > MAX_APPLY) return NextResponse.json({ ok: false, error: `행이 너무 많습니다(${rows.length.toLocaleString()}). 대량은 백필 스크립트로.` }, { status: 413 });

    const opts = readUploadOptions(form);
    const plan = planUpload(rows, opts);
    // 오류 행(숫자 아닌 금액·수량, 날짜 오류, 오늘 이후 날짜)은 미리보기에서 보고 '오류 행 빼고 적용'을 고른 경우만 진행
    if (plan.invalid > 0 && form.get("confirm_skip_invalid") !== "1") {
      return NextResponse.json({ ok: false, error: `오류 행 ${plan.invalid.toLocaleString()}건이 있습니다 — 파일을 고치거나 '오류 행 빼고 적용'을 선택하세요.` }, { status: 400 });
    }
    // 기간 교체 — 오류 행이 있거나 기간이 없거나·틀리면 아무것도 쓰지 않고 거절(미리보기와 같은 판정)
    const period = opts.replace ? { from: opts.replaceFrom, to: opts.replaceTo } : null;
    if (period) {
      const blocked = replaceBlockReason(plan, period);
      if (blocked) return NextResponse.json({ ok: false, error: blocked }, { status: 400 });
    }
    const orders = plan.orders;
    // 고객: key별 최소/최대 날짜·이름 병합
    const custMap = new Map<string, { c: SalesCustomerRow; min: string; max: string }>();
    for (const cu of plan.customers) {
      const ex = custMap.get(cu.customer_key);
      if (!ex) custMap.set(cu.customer_key, { c: { ...cu }, min: cu.order_date, max: cu.order_date });
      else { if (cu.order_date < ex.min) ex.min = cu.order_date; if (cu.order_date > ex.max) ex.max = cu.order_date; if (cu.customer_name) ex.c.customer_name = cu.customer_name; }
    }

    const sb = supabaseAdmin();

    // 삽입 전 기존 개수(정확한 신규 건수 산출)
    const hashes = orders.map((o) => o.row_hash);
    let existed = 0;
    for (let i = 0; i < hashes.length; i += 100) {   // 100개씩 — 큰 .in() 은 요청 URL 길이 초과로 게이트웨이 400
      const { data, error } = await sb.from("sales_orders").select("row_hash").in("row_hash", hashes.slice(i, i + 100));
      if (error) return NextResponse.json({ ok: false, error: `DB 조회 오류: ${error.message}` }, { status: 500 });
      existed += data?.length || 0;
    }

    // 기간 교체 — 지울 기존 행을 쓰기 전에 확정(조회 실패면 아무것도 쓰지 않고 멈춘다)
    //  채널마다 지우는 날짜 = 그 채널 파일 날짜(replace_widen=1 이면 교체 기간 전체).
    //  파일에 그 채널 행이 없거나 지울 행보다 적은 날의 기존 행을 지우게 되면, 미리보기에서 그 날짜를 확인(confirm_uncovered)한 경우만 — 아니면 쓰기 전에 거절.
    let replacePlan: Awaited<ReturnType<typeof planReplace>> | null = null;
    if (period) {
      try { replacePlan = await planReplace(sb, orders, period, opts.replaceWiden); }
      catch (e) { return NextResponse.json({ ok: false, error: `기간 교체 범위 조회 오류: ${(e as Error).message}` }, { status: 500 }); }
      const unconfirmed = uncoveredBlockReason(replacePlan.scopes, opts.confirmUncovered);
      if (unconfirmed) return NextResponse.json({ ok: false, error: unconfirmed }, { status: 400 });
      // 미리보기 숫자 = 적용 결과 — 화면이 확인창에 보여 준 지울 행 수(expect_delete)와 지금 다시 계산한 수가 다르면 쓰기 전에 거절
      //  (미리보기 뒤 다른 업로드·옵션 불일치). 값이 없으면(구 화면) 검사하지 않는다.
      const expectRaw = String(form.get("expect_delete") ?? "").trim();
      if (expectRaw !== "") {
        const expect = Number(expectRaw);
        if (!Number.isInteger(expect) || expect !== replacePlan.staleIds.length) {
          return NextResponse.json({ ok: false, error: `지울 기존 행이 미리보기와 다릅니다(미리보기 ${Number.isFinite(expect) ? expect.toLocaleString() : "?"}행 · 지금 ${replacePlan.staleIds.length.toLocaleString()}행) — 아무것도 쓰지 않았습니다. 미리보기를 다시 하세요.` }, { status: 409 });
        }
      }
    }
    const noteParts: string[] = [];
    if (period && replacePlan?.scopes.length) {
      const uncDays = replacePlan.scopes.reduce((n, x) => n + x.uncovered.length, 0);
      noteParts.push(`기간 교체 ${replacePlan.scopes.map((x) => `${x.channel} ${x.win_from}~${x.win_to}`).join(", ")}${uncDays ? ` (파일 행이 없거나 적은 날 ${uncDays}일 포함)` : ""}`);
    }
    if (opts.dupMode === "separate" && plan.dupGroupCount > 0) noteParts.push("동일 라인 따로 넣기");

    // 배치 id — 이 업로드가 '새로 삽입한' 행에만 태깅(멱등이라 기존 중복행은 미변경) → 되돌리기 시 정확히 이 배치분만 삭제.
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14); // yyyymmddhhmmss(UTC)
    const batchId = `web-${stamp}-${randomUUID().slice(0, 4)}`;

    // 업로드 이력을 '적재 전에' 먼저 기록 — 이력이 맨 끝이면 중간 실패/타임아웃 시 이미 삽입된 행이
    //  되돌리기 불가 고아 배치로 남는다(감사 확정). 실패해도 이 기록으로 되돌리기가 가능하다.
    //  이력 기록이 실패하면(note 칸 없이 다시 넣기까지 실패) 매출 행을 하나도 쓰지 않고 멈춘다 — 이력 없이 넣으면 되돌릴 수 없고
    //  기간 교체로 지운 행의 기록도 남지 않는다(S3·S4).
    //  (신규 0건·삭제 0건으로 끝나면 아래에서 이력을 지워 목록을 어지럽히지 않는다)
    const uploadRow = {
      id: batchId, filename: file.name, total_rows: rows.length,
      inserted: 0, skipped: 0, uploaded_by: await currentActor(), status: "active",
    };
    const note = noteParts.join(" · ") || null;
    let noteSaved = false;
    {
      const withNote: Record<string, unknown> = note ? { ...uploadRow, note } : uploadRow;
      let { error } = await sb.from("sales_uploads").insert(withNote);
      if (error && note && /note/i.test(error.message || "")) ({ error } = await sb.from("sales_uploads").insert(uploadRow)); // 133 미적용 — 메모 없이
      else if (!error) noteSaved = !!note;
      if (error) {
        // 응답만 실패하고 들어갔을 수 있다 — 매출 행은 아직 없으니 이력도 지워 둔다(실패해도 무시: 신규 0건 이력일 뿐)
        await sb.from("sales_uploads").delete().eq("id", batchId).then(() => undefined, () => undefined);
        return NextResponse.json({ ok: false, error: `업로드 이력 기록 실패 — 아무것도 쓰지 않았습니다: ${error.message}` }, { status: 500 });
      }
    }

    // 이 배치로 태그된 행 수 — 계산값(파일 행 − 기존 행) 대신 실제로 넣은 행을 센다(동시 업로드·중간 실패에도 정확). 못 세면 null.
    const countBatch = async (): Promise<number | null> => {
      const { count, error } = await sb.from("sales_orders").select("id", { count: "exact", head: true }).eq("upload_batch", batchId);
      return error || count == null ? null : count;
    };
    // 이력 갱신 — 넣기 뒤의 성공·실패 경로 모두에서 부른다. 실패해도 응답은 그대로 보낸다(best-effort).
    //  메모 = 계획 메모 + 교체 삭제 결과(delMemo). delMemo 가 없으면 계획 메모로 되돌린다('삭제 중' 표시 지우기).
    const saveHistory = async (upd: Record<string, unknown>, delMemo: string | null) => {
      if (noteSaved) upd.note = delMemo ? `${note} · ${delMemo}` : note;
      await sb.from("sales_uploads").update(upd).eq("id", batchId).then(() => undefined, () => undefined);
    };
    const dropHistory = () => sb.from("sales_uploads").delete().eq("id", batchId).then(() => undefined, () => undefined);

    // 멱등 upsert(중복 무시) — 기간 교체여도 넣기를 먼저 해, 중간에 실패해도 파일 행이 빠진 채 남지 않는다
    for (let i = 0; i < orders.length; i += 1000) {
      const chunk = orders.slice(i, i + 1000).map((o) => ({ ...o, source: "web", upload_batch: batchId }));
      const { error } = await sb.from("sales_orders").upsert(chunk, { onConflict: "row_hash", ignoreDuplicates: true });
      if (error) {
        // 앞 묶음은 들어갔을 수 있다 — 넣은 건수를 세어 이력에 남긴다(되돌리기 확인창도 실제 행 수를 센다). 0건이면 이력을 지운다.
        const n = await countBatch();
        if (n === 0) await dropHistory();
        else if (n != null) { await saveHistory({ inserted: n }, null); await logSalesUpload(file.name, n, 0); }
        const done = n === 0 ? "넣은 행 없음" : n == null ? "일부가 들어갔을 수 있음(최근 업로드에서 확인)" : `${n.toLocaleString()}건까지 넣음`;
        return NextResponse.json({ ok: false, error: `적재 오류: ${error.message} — ${done}. 기존 행은 지우지 않았습니다. 같은 파일을 다시 적용하면 나머지를 넣습니다.` }, { status: 500 });
      }
    }

    const counted = await countBatch();
    const inserted = counted ?? Math.max(0, orders.length - existed);
    const skipped = rows.length - inserted;
    const stale = replacePlan?.staleIds.length ?? 0;
    // 교체 삭제 전에 넣은 건수와 '삭제 중' 표시를 먼저 남긴다 — 삭제 도중 시간 초과로 끊겨도 신규 건수와 지울 행 수가 이력에 남는다
    if (stale > 0) await saveHistory({ inserted, skipped }, `기존 ${stale.toLocaleString()}행 삭제 중`);

    // 기간 교체 — 파일에 없는 기존 행 삭제(도매·b2b 행 제외).
    //  중간 실패면 이력에 '중단'과 지운 행 수를 남기고 멈춘다. 같은 파일로 미리보기를 다시 하면 남은 행만 지울 행으로 잡힌다
    //  (예전 미리보기 그대로 다시 적용하면 expect_delete 가 달라 409).
    let deleted = 0;
    if (replacePlan) {
      const ids = replacePlan.staleIds;
      for (let i = 0; i < ids.length; i += 100) {
        const { error, count } = await sb.from("sales_orders").delete({ count: "exact" })
          .in("id", ids.slice(i, i + 100)).neq("source", "b2b").neq("channel", "도매");
        if (error) {
          if (inserted > 0 || deleted > 0) {
            await saveHistory({ inserted, skipped }, `기존 ${stale.toLocaleString()}행 중 ${deleted.toLocaleString()}행 삭제(중단)`);
            await logSalesUpload(file.name, inserted, skipped);
          } else await dropHistory();
          return NextResponse.json({ ok: false, error: `기간 교체 삭제 오류(신규 ${inserted.toLocaleString()}건 넣음 · 기존 ${deleted.toLocaleString()}행까지 삭제됨): ${error.message} — 같은 파일로 미리보기를 다시 한 뒤 적용하면 남은 행을 지웁니다.` }, { status: 500 });
        }
        deleted += count ?? 0;
      }
    }

    // 이력 확정 — 신규 삽입·교체 삭제가 있으면 건수 갱신, 아무 변화가 없으면 이력 삭제(종전 규칙 유지).
    //  고객 저장보다 먼저 한다 — 고객 단계에서 실패·시간 초과가 나도 원장 쓰기 기록은 이미 맞다.
    if (inserted > 0 || deleted > 0) await saveHistory({ inserted, skipped }, deleted > 0 ? `기존 ${deleted.toLocaleString()}행 삭제` : null);
    else await dropHistory();
    await logSalesUpload(file.name, inserted, skipped);
    const applied = `매출은 반영됨 — 신규 ${inserted.toLocaleString()}건${deleted > 0 ? ` · 기존 ${deleted.toLocaleString()}행 삭제` : ""}`;

    // 고객 조회 테이블 병합 upsert(first/last/name). order_count는 검색 시 실시간 계산 → 여기선 미유지.
    //  기존 값 조회가 실패하면 멈춘다 — '없음'으로 보고 덮으면 첫 구매일이 이 파일 날짜로 당겨진다(S4).
    const keys = [...custMap.keys()];
    const existing = new Map<string, { first_seen_date: string | null; last_seen_date: string | null }>();
    for (let i = 0; i < keys.length; i += 100) {     // 100개씩 — .in() URL 길이 한도 회피
      const { data, error } = await sb.from("sales_customers").select("customer_key, first_seen_date, last_seen_date").in("customer_key", keys.slice(i, i + 100));
      if (error) return NextResponse.json({ ok: false, error: `고객 조회 오류(${applied}): ${error.message} — 같은 파일로 미리보기를 다시 한 뒤 적용하면 고객 정보만 저장합니다.` }, { status: 500 });
      for (const r of data || []) existing.set(r.customer_key, { first_seen_date: r.first_seen_date, last_seen_date: r.last_seen_date });
    }
    const custRows = keys.map((k) => {
      const v = custMap.get(k)!;
      const ex = existing.get(k);
      const first = ex?.first_seen_date && ex.first_seen_date < v.min ? ex.first_seen_date : v.min;
      const last = ex?.last_seen_date && ex.last_seen_date > v.max ? ex.last_seen_date : v.max;
      return { customer_key: k, phone: v.c.phone, phone_digits: v.c.phone_digits, customer_name: v.c.customer_name, first_seen_date: first, last_seen_date: last, updated_at: new Date().toISOString() };
    });
    for (let i = 0; i < custRows.length; i += 1000) {
      const { error } = await sb.from("sales_customers").upsert(custRows.slice(i, i + 1000), { onConflict: "customer_key" });
      if (error) return NextResponse.json({ ok: false, error: `고객 저장 오류(${applied}): ${error.message} — 같은 파일로 미리보기를 다시 한 뒤 적용하면 고객 정보만 저장합니다.` }, { status: 500 });
    }
    // 최근 3일(어제~사흘 전) 매출이 파일에 있으면 화면이 날짜마다 '일일 종합 리포트 생성' 안내 창을 띄운다(2026-09-30 — 담당자가 생성·발송, 자동 실행 없음).
    //  월요일 업로드 = 금·토·일. 중복 재업로드여도 띄운다(분석은 매출이 그대로면 건너뛰어 멱등).
    //  주간·월간은 그 기간 마지막 날(지난주 일요일·지난달 말일) 매출이 파일에 있으면 함께 안내한다.
    const has = (d: string) => orders.some((o) => o.order_date === d);
    const wk = lastWeek(), mo = lastMonth();
    const reportItems = [
      ...[kstDay(1), kstDay(2), kstDay(3)].filter(has).map((d) => ({ period: "daily", date: d, label: md(d) })),
      ...(has(wk.until) ? [{ period: "weekly", date: wk.since, label: periodLabel("weekly", wk) }] : []),
      ...(has(mo.until) ? [{ period: "monthly", date: mo.since, label: periodLabel("monthly", mo) }] : []),
    ];
    const { data: bounds } = await sb.rpc("sales_date_bounds");
    const totalAfter = Array.isArray(bounds) && bounds[0] ? (bounds[0].total_rows as number) : null;
    return NextResponse.json({ ok: true, inserted, skipped, deleted, total_after: totalAfter, batch_id: inserted > 0 ? batchId : null, report_items: reportItems });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
