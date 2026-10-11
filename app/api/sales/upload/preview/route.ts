import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { parseSalesFile } from "@/app/lib/sales-parse";
import { planUpload, planReplace, readUploadOptions, findChangedRows, defaultReplacePeriod, monthReplacePeriod, replaceBlockReason, uncoveredKeys, type ReplacePeriod, type ReplaceScope } from "@/app/lib/sales-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PREVIEW = 50000;   // 대량은 백필 스크립트로 유도

// 파일 파싱→정규화→파일내/DB 중복 계산(+기간 교체 시 지워질 기존 행). DB 미기록(순수 미리보기).
//  옵션(dup_mode·replace·replace_from/to·replace_widen)은 적용 때도 같은 값을 보내야 미리보기 숫자와 결과가 같다.
//  교체 기간을 안 보내면 기본 기간(파일에 실제로 있는 날짜 최소~최대)을 계산해 돌려준다 — 화면이 그 기간을 적용 때 그대로 보낸다.
//  채널마다 지우는 날짜는 기본이 그 채널 파일 날짜 — 교체 기간 전체로 넓히는 건 replace_widen=1 일 때만.
//  default_period(파일 날짜)·month_period(그 달 1일~말일 — 월 정산 대조용)는 받은 기간과 무관하게 함께 돌려준다(화면의 교체 범위 버튼).
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "파일이 첨부되지 않았습니다." }, { status: 400 });
    const opts = readUploadOptions(form);

    const { rows } = await parseSalesFile(file);
    if (rows.length === 0) return NextResponse.json({ ok: false, error: "행을 찾지 못했습니다. 헤더(주문일자·결제금액 등)가 포함된 파일인지 확인하세요." }, { status: 400 });
    if (rows.length > MAX_PREVIEW) return NextResponse.json({ ok: false, error: `행이 ${rows.length.toLocaleString()}개입니다. 대량 이관(과거 전체)은 백필 스크립트를 사용하세요. 웹 업로드는 최대 ${MAX_PREVIEW.toLocaleString()}행.` }, { status: 413 });

    let plan;
    try { plan = planUpload(rows, opts); }
    catch (e) { return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 }); }
    const orders = plan.orders;

    // DB 중복(row_hash 존재) 조회
    const sb = supabaseAdmin();
    const hashes = orders.map((o) => o.row_hash);
    const existingHashes = new Set<string>();
    for (let i = 0; i < hashes.length; i += 100) {   // 100개씩 — 큰 .in() 은 요청 URL 길이 초과로 게이트웨이 400(Bad Request)
      const { data, error } = await sb.from("sales_orders").select("row_hash").in("row_hash", hashes.slice(i, i + 100));
      if (error) return NextResponse.json({ ok: false, error: `DB 조회 오류: ${error.message} (마이그레이션 039 적용 확인)` }, { status: 500 });
      for (const r of data || []) existingHashes.add(r.row_hash as string);
    }
    const dupInDb = existingHashes.size;

    // 기간 교체 — 지워질 기존 행(조회 실패면 미리보기 자체를 실패로: 지울 범위를 모른 채 적용하지 않게).
    //  막는 이유(오류 행·기간 오류)가 있으면 미리보기는 보여 주되 교체 계획 없이 이유만 — 적용은 같은 이유로 거절된다.
    //  uncovered_keys = 파일에 그 채널 행이 없거나 지울 행보다 적은데 기존 행이 지워지는 날(채널|날짜) — 화면이 확인 체크 후 적용 때 그대로 보낸다.
    let replace: { period: ReplacePeriod | null; default_period: ReplacePeriod | null; month_period: ReplacePeriod | null; widen: boolean; blocked: string | null; scopes: ReplaceScope[]; skipped: string[]; outside: number; uncovered_keys: string[] } | null = null;
    let changed = null;
    if (opts.replace) {
      const defaultPeriod = defaultReplacePeriod(orders), monthPeriod = monthReplacePeriod(orders);
      const period = opts.replaceFrom || opts.replaceTo ? { from: opts.replaceFrom, to: opts.replaceTo } : defaultPeriod;
      const ranges = { default_period: defaultPeriod, month_period: monthPeriod };
      // 기본 기간을 못 정함 = 교체 대상 채널 행이 없음(도매·채널 없음뿐) — 오류 행 이유가 먼저
      const blocked = period || plan.invalid > 0 ? replaceBlockReason(plan, period) : "교체할 채널 행이 없습니다(도매 제외) — '기간 교체'를 끄고 적용하세요.";
      if (blocked || !period) replace = { period, ...ranges, widen: opts.replaceWiden, blocked: blocked || "교체 기간이 없습니다.", scopes: [], skipped: [], outside: 0, uncovered_keys: [] };
      else {
        const r = await planReplace(sb, orders, period, opts.replaceWiden);
        replace = { period, ...ranges, widen: opts.replaceWiden, blocked: null, scopes: r.scopes, skipped: r.skipped, outside: r.outside, uncovered_keys: uncoveredKeys(r.scopes) };
      }
    } else {
      // 추가만 할 때 — 같은 주문·상품인데 수량·금액이 바뀐 행(업로드 뒤 취소·정정)을 보여 준다
      changed = await findChangedRows(sb, orders, existingHashes);
    }

    const dates = orders.map((o) => o.order_date).sort();
    const channels = [...new Set(orders.map((o) => o.channel).filter(Boolean))];
    const revenue = orders.reduce((s, o) => s + o.subtotal_amount, 0);
    const sample = orders.slice(0, 30).map((o) => ({
      order_date: o.order_date, channel: o.channel, order_id: o.order_id,
      product_name: o.product_name, sku_code: o.sku_code, quantity: o.quantity, subtotal_amount: o.subtotal_amount,
    }));

    return NextResponse.json({
      ok: true,
      options: { dup_mode: opts.dupMode, replace: opts.replace, replace_from: replace?.period?.from ?? null, replace_to: replace?.period?.to ?? null, replace_widen: opts.replace && opts.replaceWiden },
      summary: { total_rows: rows.length, valid: orders.length, invalid: plan.invalid, dup_in_file: plan.dupInFile, dup_in_db: dupInDb, new_rows: orders.length - dupInDb, revenue },
      date_range: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
      channels, sample, errors: plan.errors,
      dup_groups: plan.dupGroups, dup_group_count: plan.dupGroupCount,
      replace, changed,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
