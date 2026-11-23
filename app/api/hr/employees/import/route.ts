import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { clientIp, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { ImportError, applyEmployees, employeeReport, loadSheets, planEmployees, uploadProblem } from "@/app/lib/hr-import-db";
import { EMP_REQUIRED_LABELS, EMP_XLSX_LABELS } from "@/app/lib/hr-import";
import { markRequired } from "@/app/lib/hr-xlsx-style";
import { EMP_TYPES } from "@/app/lib/hr";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const UUID = /^[0-9a-f-]{36}$/i;

// 양식: 내려받는 인사대장과 같은 칸의 빈 표 + 작성 방법. 번호·계좌처럼 앞의 0 이 떨어지면 안 되는 칸은 글자 서식으로 둔다.
async function template(): Promise<NextResponse> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("인사대장");
  ws.addRow(EMP_XLSX_LABELS);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
  markRequired(ws, 1, EMP_REQUIRED_LABELS);   // 올릴 때 꼭 있어야 하는 칸은 노랗게
  EMP_XLSX_LABELS.forEach((l, i) => {
    const c = ws.getColumn(i + 1);
    c.width = ["주소", "이력", "메모", "퇴사 사유"].includes(l) ? 30 : ["주민등록번호", "임금 적용 시작일", "소정근로 요일"].includes(l) ? 18 : 13;
    if (["주민등록번호", "연락처", "비상 연락처", "계좌번호", "입사일", "퇴사일", "계약 시작", "계약 종료", "임금 적용 시작일", "출근", "퇴근"].includes(l)) c.numFmt = "@";
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];

  const help = wb.addWorksheet("작성 방법");
  help.addRow(["칸", "넣는 값"]);
  help.getRow(1).font = { bold: true };
  const rows: [string, string][] = [
    ["한 줄", "한 사람. 머리 줄(칸 이름)은 지우지 않는다. 칸의 순서는 바꿔도 되고, 쓰지 않는 칸은 지워도 된다"],
    ["새 직원에 꼭 넣는 칸(노란 칸)", "성명, 입사일, 시급(월급제는 월급 — 둘 가운데 하나)"],
    ["이미 있는 직원", "주민등록번호 → 성명과 입사일 순으로 같은 사람을 찾아 고친다. 빈 칸은 건드리지 않는다"],
    ["사업장 이름", "[사업장]에 등록한 이름 그대로. 사업장이 하나면 비워도 된다"],
    ["소속 이름", "[사업장 수정]의 소속 목록에 있는 이름 그대로(예: 파도소리). 소속을 쓰지 않으면 비운다"],
    ["주민등록번호 13자리", "900101-1234567 처럼. 가려진 번호(900101-1******)는 건드리지 않는다. 생년월일·성별은 번호에서 정해진다"],
    ["날짜 칸", "2026-03-02 처럼(엑셀 날짜 칸도 된다)"],
    ["급여 형태 칸", "시급 또는 월급. 비우면 시급(월급만 넣었으면 월급)"],
    ["임금 적용 시작일 칸", "새 직원은 비우면 입사일. 이미 있는 직원의 시급·월급을 바꿀 때는 꼭 넣는다(그날부터 새 금액)"],
    ["소정근로 요일 칸", "월·화·수·목·금 또는 월~금. 비우면 월~금"],
    ["출근 · 퇴근 칸", "09:00 처럼. 비우면 09:00, 18:00"],
    ["휴게(분) 칸", "숫자. 비우면 60"],
    ["하루 시간 칸", "숫자. 비우면 출근·퇴근·휴게로 계산한다"],
    ["고용 형태 칸", `${EMP_TYPES.join(" · ")} 가운데 하나`],
    ["공제대상가족 칸", "본인을 포함한 수. 비우면 1"],
    ["원천징수(%) 칸", "80 · 100 · 120 가운데 하나. 비우면 100"],
    ["4대보험 칸(국민연금 등)", "가입 또는 제외. 비우면 가입"],
    ["보험 기준 칸", "공단 고지 또는 그달 급여. 공단 고지이면 기준소득월액·보수월액을 고지서대로 넣는다"],
    ["연차 기준 칸", "입사일 기준 또는 회계연도 기준. 비우면 사업장 기본값"],
  ];
  for (const r of rows) help.addRow(r);
  help.getColumn(1).width = 26; help.getColumn(2).width = 90;

  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="employees-template.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}

// POST /api/hr/employees/import — 인사대장 엑셀 올리기
//   { template: true }                          → 빈 양식(.xlsx)
//   { name, file(base64 .xlsx), workplace_id? }  → 미리보기(줄마다 새로·고침·같음·오류)
//   { …, apply: true }                          → 파일을 다시 읽어 대조한 뒤 등록
//  workplace_id = 사업장 칸이 빈 줄에 쓸 사업장. 오류가 있는 줄은 넣지 않고 나머지를 넣는다.
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { template?: boolean; name?: string; file?: string; workplace_id?: string; apply?: boolean };
    if (body.template === true) return await template();

    const name = String(body.name ?? "").trim().slice(0, 200);
    const b64 = String(body.file ?? "");
    const problem = uploadProblem(name, b64);
    if (problem) return hrJson({ ok: false, error: problem }, 400);
    const wp = UUID.test(String(body.workplace_id ?? "")) ? String(body.workplace_id) : "";

    const plan = await planEmployees(await loadSheets(b64), wp);
    if (body.apply !== true) return hrJson({ ok: true, ...employeeReport(plan) });
    const done = await applyEmployees(plan, who.name, clientIp(req), name);
    return hrJson({ ok: true, ...employeeReport(plan, done), created: done.created, updated: done.updated });
  } catch (err) {
    if (err instanceof ImportError) return hrJson({ ok: false, error: err.message }, 400);
    return hrError(err, "인사대장 엑셀을 올리지 못했습니다.");
  }
}
