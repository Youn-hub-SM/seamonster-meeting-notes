// 스마트스토어 리뷰 엑셀 → shop_reviews 행 — 서버 전용.
//  네이버 커머스API 에는 리뷰 조회가 없다(2026-11-12 확인) → 판매자센터 › 리뷰 관리의 엑셀을 담당자가 올린다.
//  엑셀 칸(2026-11 실파일): 상품번호 · 상품명 · 리뷰구분 · 구매자평점 · 포토/영상 · 리뷰상세내용 · 등록자 · 리뷰등록일(YYYY.MM.DD. HH:mm:ss, 한국 시간)
//   · 리뷰글번호 · 전시상태 · 상품주문번호 …
//  개인정보: 등록자(가린 아이디)·상품주문번호는 읽지 않는다. 저장하는 것은 본문·별점·상품·작성 시각뿐.
//  저장 키: channel '스마트스토어' + board_no 0 + article_no = 리뷰글번호 → 같은 파일을 다시 올려도 겹치지 않는다.
import ExcelJS from "exceljs";

export const NAVER_REVIEW_CHANNEL = "스마트스토어";
export type ReviewRow = {
  channel: string; board_no: number; article_no: number; product_no: number | null; product_name: string | null;
  rating: number | null; title: string | null; content: string | null; has_photo: boolean; written_at: string | null; synced_at: string;
};

function cellStr(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("");
    if (typeof o.text === "string") return o.text;
    return o.result != null ? String(o.result) : "";
  }
  return String(v);
}
const clean = (s: string, max: number) => { const t = s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); return t ? t.slice(0, max) : null; };
// '2022.11.13. 20:35:20'(한국 시간) → ISO. 엑셀이 날짜 칸으로 준 경우(ISO 문자열)도 받는다.
function kstToIso(s: string): string | null {
  const m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    const t = Date.parse(`${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:${se || "00"}+09:00`);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const NEED = ["리뷰글번호", "리뷰상세내용", "리뷰등록일"];
export type NaverParse = { rows: ReviewRow[]; total: number; skipped: number };

// 헤더 이름으로 칸을 찾는다(칸 순서가 바뀌어도 읽는다). 필수 칸이 없으면 무엇이 없는지 말한다.
export async function parseNaverReviewXlsx(buf: ArrayBuffer): Promise<NaverParse> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("엑셀에 시트가 없습니다.");
  const col = new Map<string, number>();
  ws.getRow(1).eachCell((cell, c) => { const k = cellStr(cell.value).replace(/\s+/g, ""); if (k) col.set(k, c); });
  const missing = NEED.filter((k) => !col.has(k));
  if (missing.length) throw new Error(`스마트스토어 리뷰 엑셀이 아닙니다 — '${missing.join("', '")}' 칸이 없습니다. 판매자센터 › 리뷰 관리에서 내려받은 파일을 올리세요.`);
  const get = (row: ExcelJS.Row, k: string) => (col.has(k) ? cellStr(row.getCell(col.get(k)!).value).trim() : "");
  const now = new Date().toISOString();
  const rows: ReviewRow[] = [];
  const seen = new Set<number>();
  let total = 0, skipped = 0;
  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const no = Number(get(r, "리뷰글번호"));
    if (!Number.isSafeInteger(no) || no <= 0) continue;       // 빈 줄
    total++;
    const content = clean(get(r, "리뷰상세내용"), 4000);
    const state = get(r, "전시상태");
    if (!content || (state && state !== "정상") || seen.has(no)) { skipped++; continue; } // 내용 없음·숨김 처리·같은 번호
    seen.add(no);
    const rating = Number(get(r, "구매자평점")), pno = Number(get(r, "상품번호"));
    rows.push({
      channel: NAVER_REVIEW_CHANNEL, board_no: 0, article_no: no,
      product_no: Number.isSafeInteger(pno) && pno > 0 ? pno : null, product_name: clean(get(r, "상품명"), 200),
      rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null, title: null, content,
      has_photo: !!get(r, "포토/영상"), written_at: kstToIso(get(r, "리뷰등록일")), synced_at: now,
    });
  }
  return { rows, total, skipped };
}
