import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { WORK_REQUIRED_LABELS } from "@/app/lib/hr-import";
import { markRequired } from "@/app/lib/hr-xlsx-style";
import { HR_PENDING_002, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { fetchLogs, fetchRoster, fetchWorkplaces } from "@/app/lib/hr-work-db";
import { LEAVE_PART_LABEL, WORK_KIND_LABEL, isMonth, monthRange, summarizeMonth, weekdayOf } from "@/app/lib/hr-work";
import { WEEKDAYS } from "@/app/lib/hr";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f-]{36}$/i;

// POST /api/hr/work-logs/export — 근무대장 엑셀. { month, employee_id? }
//  employee_id 가 있으면 그 직원 한 시트, 없으면 그 달 재직자 전원(직원마다 한 시트 + 맨 앞 요약 시트).
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { month?: string; employee_id?: string };
    const month = String(body.month ?? "");
    const employeeId = String(body.employee_id ?? "");
    if (!isMonth(month)) return hrJson({ ok: false, error: "달을 고르세요." }, 400);
    if (employeeId && !UUID.test(employeeId)) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);

    const [workplaces, employees] = await Promise.all([fetchWorkplaces(), fetchRoster(month, employeeId || undefined)]);
    if (employees.length === 0) return hrJson({ ok: false, error: "그 달에 재직한 직원이 없습니다." }, 404);
    const logs = await fetchLogs(month, employees.map((e) => e.id));
    const wpOf = new Map(workplaces.map((w) => [w.id, w]));
    const { days } = monthRange(month);

    const wb = new ExcelJS.Workbook();
    const head = (ws: ExcelJS.Worksheet, row: number) => {
      ws.getRow(row).font = { bold: true };
      ws.getRow(row).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
    };
    const SUM_HEAD = ["사업장", "성명", "근무 일수", "근무 시간", "연장", "야간", "휴일 근무", "주휴", "유급 휴일", "연차(일)", "결근", "입력 전"];
    const sumSheet = employeeId ? null : wb.addWorksheet("요약");
    if (sumSheet) { sumSheet.addRow([`근무대장 ${month}`]); sumSheet.addRow(SUM_HEAD); head(sumSheet, 2); }

    const used = new Set<string>();
    for (const e of employees) {
      const wp = wpOf.get(e.workplace_id);
      if (!wp) continue;
      const mine = logs.filter((l) => l.employee_id === e.id);
      const s = summarizeMonth(e, wp, mine, month);
      const byDate = new Map(mine.map((l) => [l.work_date, l]));
      sumSheet?.addRow([wp.name, e.name, s.workDays, s.worked, s.overtime, s.night, s.holidayBase + s.holidayOver, s.weeklyHours, s.paidHolidayHours, s.leaveDays, s.absentDays, s.missingDays]);

      // 시트 이름: 31자 이하·중복 금지·금지 문자 제거
      let title = (e.name || "직원").replace(/[\\/?*[\]:]/g, " ").slice(0, 24) || "직원";
      for (let i = 2; used.has(title); i++) title = `${title.slice(0, 24)} ${i}`;
      used.add(title);
      const ws = wb.addWorksheet(title);
      ws.addRow([`근무대장 ${month}`, "", wp.name, e.name, "", e.dept, e.position]);
      ws.getRow(1).font = { bold: true };
      ws.addRow(["날짜", "요일", "종류", "출근", "퇴근", "휴게(분)", "근무 시간", "야간", "연장", "연차", "비고"]);
      head(ws, 2);
      markRequired(ws, 2, WORK_REQUIRED_LABELS);   // 올릴 때 꼭 있어야 하는 칸(날짜·종류)은 노랗게
      for (const d of days) {
        const l = byDate.get(d);
        ws.addRow([d, WEEKDAYS[weekdayOf(d) - 1], l ? WORK_KIND_LABEL[l.kind] : "", l?.start_time || "", l?.end_time || "",
          l && l.start_time ? l.break_min : "", l && l.hours ? l.hours : "", l && l.night_hours ? l.night_hours : "",
          s.overtimeByDay[d] || "", l && l.leave_days ? LEAVE_PART_LABEL[String(l.leave_days)] || l.leave_days : "", l?.memo || ""]);
      }
      ws.addRow([]);
      ws.addRow(["주", "", "근무 시간", "연장", "야간", "휴일 근무", "주휴", "주휴 없는 이유", "주휴를 넣는 달"]);
      head(ws, ws.rowCount);
      for (const w of s.weeks) ws.addRow([`${w.start} ~ ${w.end}`, "", w.worked, w.overtime, w.night, w.holiday, w.weeklyHours, w.weeklyReason, w.payMonth]);
      ws.addRow([]);
      ws.addRow(["합계", "", "근무 일수", "근무 시간", "연장", "야간", "휴일 근무(8시간까지)", "휴일 근무(8시간 초과)", "주휴", "유급 휴일", "연차(일)", "결근", "무급 휴무", "입력 전"]);
      head(ws, ws.rowCount);
      ws.addRow([month, "", s.workDays, s.worked, s.overtime, s.night, s.holidayBase, s.holidayOver, s.weeklyHours, s.paidHolidayHours, s.leaveDays, s.absentDays, s.unpaidDays, s.missingDays]);
      ws.columns.forEach((c, i) => { c.width = i === 0 ? 24 : i === 10 ? 28 : 12; });
    }
    sumSheet?.columns.forEach((c, i) => { c.width = i === 0 || i === 1 ? 16 : 11; });

    const buf = await wb.xlsx.writeBuffer();
    const name = employeeId ? `work-${month}-one.xlsx` : `work-${month}.xlsx`;
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return hrError(err, "근무대장을 내보내지 못했습니다.", HR_PENDING_002);
  }
}
