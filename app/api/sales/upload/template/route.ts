import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { HEADER_MAP_KR_TO_EN } from "@/app/lib/sales-normalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 매출 업로드 빈 양식(일회성 수기 업로드용). 헤더는 sales-normalize 매핑 키와 정확히 일치해야 인식됨.
//  '매출_업로드' 시트에 손으로 채워 그대로 올리면 preview→apply 로 적재(멱등 중복제외).
const COLS: { header: string; key: string; width: number; req: boolean; desc: string; ex: string | number }[] = [
  { header: "판매처", key: "channel", width: 14, req: false, desc: "채널명(예: 스마트스토어·쿠팡·자사몰)", ex: "스마트스토어" },
  { header: "주문일자", key: "order_date", width: 14, req: true, desc: "주문/결제일. YYYY-MM-DD 권장(엑셀 날짜·yyyymmdd도 인식)", ex: "2026-07-05" },
  { header: "주문번호", key: "order_id", width: 18, req: false, desc: "주문번호(중복검사 키의 일부). 비우면 중복판정 정확도가 떨어짐", ex: "20260705-000123" },
  { header: "상품명", key: "product_name", width: 24, req: false, desc: "상품명", ex: "씨몬스터 참돔순살 100g" },
  { header: "옵션명", key: "option_name", width: 18, req: false, desc: "옵션명(없으면 비움)", ex: "2팩" },
  { header: "관리코드", key: "sku_code", width: 16, req: false, desc: "SKU(상품마스터 매칭·원가계산에 사용). 권장", ex: "SM-CHAMDOM-100" },
  { header: "수량", key: "quantity", width: 8, req: false, desc: "정수", ex: 2 },
  { header: "판매가", key: "selling_price", width: 12, req: false, desc: "단가(숫자)", ex: 12900 },
  { header: "옵션금액", key: "option_price", width: 12, req: false, desc: "옵션 추가금(숫자)", ex: 0 },
  { header: "결제금액", key: "subtotal_amount", width: 14, req: true, desc: "실결제 매출액(숫자). 리포트 매출 기준", ex: 25800 },
  { header: "배송비결제금액", key: "shipping_fee", width: 16, req: false, desc: "배송비(숫자)", ex: 3000 },
  { header: "주문자", key: "customer_name", width: 12, req: false, desc: "선택. 이름 원본은 원장에 저장하지 않음(신규/재구매 판정용)", ex: "홍길동" },
  { header: "주문자전화번호", key: "customer_phone", width: 16, req: false, desc: "선택. 해시만 저장(원본 비저장). 신규/재구매 판정", ex: "010-1234-5678" },
];

// 안전장치: 모든 헤더가 정규화 매핑 키에 존재해야 함(오타 시 매핑 실패 방지)
const UNKNOWN = COLS.filter((c) => !(c.header in HEADER_MAP_KR_TO_EN)).map((c) => c.header);

export async function GET() {
  try {
    if (UNKNOWN.length) return NextResponse.json({ ok: false, error: `양식 헤더가 매핑에 없습니다: ${UNKNOWN.join(", ")}` }, { status: 500 });

    const wb = new ExcelJS.Workbook();

    // 시트1: 데이터 입력(행1=헤더만, 아래 행에 채워서 그대로 업로드)
    const ws = wb.addWorksheet("매출_업로드");
    ws.columns = COLS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    const head = ws.getRow(1);
    head.height = 20;
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    COLS.forEach((c, i) => {
      const cell = head.getCell(i + 1);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.req ? "FFF15A30" : "FF0D3B52" } }; // 필수=주황, 선택=남색
      cell.alignment = { vertical: "middle", horizontal: "center" };
      if (c.req) cell.note = "필수 입력";
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.getColumn("subtotal_amount").numFmt = "#,##0";
    ws.getColumn("selling_price").numFmt = "#,##0";

    // 시트2: 작성안내 — 행1 헤더에 '주문일자/결제금액'을 넣지 않아, 파서가 이 시트를 데이터로 오인하지 않게 함
    const g = wb.addWorksheet("작성안내");
    g.columns = [
      { header: "항목", key: "h", width: 16 },
      { header: "필수여부", key: "r", width: 10 },
      { header: "설명", key: "d", width: 56 },
      { header: "예시", key: "e", width: 20 },
    ];
    g.getRow(1).font = { bold: true };
    for (const c of COLS) g.addRow({ h: c.header, r: c.req ? "필수" : "선택", d: c.desc, e: String(c.ex) });
    g.addRow({});
    g.addRow({ h: "사용법", r: "", d: "① '매출_업로드' 시트에 행을 채운 뒤 매출 데이터 업로드 화면에서 그대로 올리세요. ② 미리보기로 신규/중복을 확인한 뒤 적용합니다. ③ 같은 파일/행을 다시 올려도 중복은 자동 제외됩니다(멱등). ④ 헤더 이름은 바꾸지 마세요(매핑 기준).", e: "" });

    const buf = await wb.xlsx.writeBuffer();
    const fname = "매출업로드_양식.xlsx";
    return new NextResponse(Buffer.from(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="sales-upload-template.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
