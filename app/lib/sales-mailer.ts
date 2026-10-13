// 매출 리포트 메일 발송 — nodemailer(SMTP). 서버 전용. 호출: /api/sales/report/send(일일·주간 매출 리포트) ·
//  analyst.ts sendReport(종합 리포트, 2026-10-13 — opts.timeoutMs 로 상한을 건다).
import nodemailer from "nodemailer";

export function defaultRecipients(): string[] {
  return (process.env.SALES_MAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// opts.timeoutMs: SMTP 연결·인사·소켓 대기 상한(ms). 없으면 nodemailer 기본값 그대로(매출 리포트 발송은 종전과 같다).
export async function sendSalesMail(m: { subject: string; text: string; html?: string; to: string[] }, opts?: { timeoutMs?: number }): Promise<string> {
  const host = process.env.SALES_SMTP_HOST, port = Number(process.env.SALES_SMTP_PORT || 587);
  const user = process.env.SALES_SMTP_USER, pass = process.env.SALES_SMTP_PASSWORD;
  if (!host || !user || !pass) throw new Error("SALES_SMTP_HOST/USER/PASSWORD 환경변수가 설정되어 있지 않습니다.");
  if (!m.to.length) throw new Error("수신자가 없습니다.");
  const t = opts?.timeoutMs;
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass }, ...(t ? { connectionTimeout: t, greetingTimeout: t, socketTimeout: t } : {}) });
  const info = await transport.sendMail({ from: user, to: m.to.join(", "), subject: m.subject, text: m.text, html: m.html });
  return info.messageId;
}
