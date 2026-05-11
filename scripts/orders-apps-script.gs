/**
 * 씨몬스터 도매 발주 관리 - Google Apps Script Web App
 *
 * 사용법:
 *   1. 대상 구글시트에서 Extensions → Apps Script 열기
 *   2. 이 파일 내용 전체를 Code.gs 에 붙여넣기
 *   3. 우측 상단 "Deploy" → "New deployment"
 *      - Type: Web app
 *      - Execute as: Me (본인 계정)
 *      - Who has access: Anyone (※ URL을 아는 사람만 접근 가능)
 *   4. 생성된 Web app URL 을 Vercel 환경변수 ORDERS_SHEET_API_URL 에 등록
 *
 * 시트 헤더 (1행, A열부터):
 *   ID | 발주일 | 생산일 | 발송일 | 거래처명 | 생산품목 | 규격 | 중량 | 수량 | 상태 | 비고
 */

const SHEET_NAME = '발주목록'; // 시트 탭 이름 (다르면 여기 수정)

const HEADERS = [
  'ID', '발주일', '생산일', '발송일',
  '거래처명', '생산품목', '규격', '중량', '수량', '상태', '비고'
];

const KEY_MAP = {
  'ID': 'id',
  '발주일': 'orderDate',
  '생산일': 'productionDate',
  '발송일': 'shipDate',
  '거래처명': 'client',
  '생산품목': 'product',
  '규격': 'spec',
  '중량': 'weight',
  '수량': 'quantity',
  '상태': 'status',
  '비고': 'note',
};

// ─────────────────────────────────────────────
// 라우터
// ─────────────────────────────────────────────
function doGet(e) {
  try {
    const orders = _readAll();
    return _json({ ok: true, orders: orders });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents
      ? JSON.parse(e.postData.contents)
      : {};
    const action = body.action;

    if (action === 'create') return _json(_create(body.order || {}));
    if (action === 'update') return _json(_update(body.order || {}));
    if (action === 'delete') return _json(_delete(body.id));

    return _json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

// ─────────────────────────────────────────────
// 핵심 로직
// ─────────────────────────────────────────────
function _sheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('시트 탭 "' + SHEET_NAME + '" 을(를) 찾을 수 없습니다.');
  }
  return sheet;
}

function _readAll() {
  const sheet = _sheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(1, 1, lastRow, HEADERS.length).getValues();
  const headers = values[0];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row[0]) continue; // ID 없는 행은 스킵
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      const key = KEY_MAP[headers[j]] || headers[j];
      obj[key] = _serialize(row[j]);
    }
    out.push(obj);
  }
  return out;
}

function _create(order) {
  const sheet = _sheet();
  const id = Utilities.getUuid();
  const row = _orderToRow({ ...order, id: id });
  sheet.appendRow(row);
  return { ok: true, id: id };
}

function _update(order) {
  if (!order.id) return { ok: false, error: 'id 누락' };
  const sheet = _sheet();
  const rowIndex = _findRow(sheet, order.id);
  if (rowIndex < 0) return { ok: false, error: '해당 ID를 찾을 수 없습니다: ' + order.id };
  const row = _orderToRow(order);
  sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  return { ok: true };
}

function _delete(id) {
  if (!id) return { ok: false, error: 'id 누락' };
  const sheet = _sheet();
  const rowIndex = _findRow(sheet, id);
  if (rowIndex < 0) return { ok: false, error: '해당 ID를 찾을 수 없습니다: ' + id };
  sheet.deleteRow(rowIndex);
  return { ok: true };
}

function _findRow(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(id)) return i + 2; // 1-based + 헤더
  }
  return -1;
}

function _orderToRow(o) {
  return [
    o.id || '',
    o.orderDate || '',
    o.productionDate || '',
    o.shipDate || '',
    o.client || '',
    o.product || '',
    o.spec || '',
    o.weight || '',
    o.quantity || '',
    o.status || '발주확인/생산대기',
    o.note || '',
  ];
}

// Date 객체는 YYYY-MM-DD 로 직렬화. 나머지는 문자열로.
function _serialize(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return v;
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
