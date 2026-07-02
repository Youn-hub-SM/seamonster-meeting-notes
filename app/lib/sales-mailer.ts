// 매출 리포트 메일 발송 — nodemailer(SMTP). 서버 전용. 발송은 /api/sales/report/send 에서만 호출.
import nodemailer from "nodemailer";

export function defaultRecipients(): string[] {
  return (process.env.SALES_MAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export async function sendSalesMail(m: { subject: string; text: string; html?: string; to: string[] }): Promise<string> {
  const host = process.env.SALES_SMTP_HOST, port = Number(process.env.SALES_SMTP_PORT || 587);
  const user = process.env.SALES_SMTP_USER, pass = process.env.SALES_SMTP_PASSWORD;
  if (!host || !user || !pass) throw new Error("SALES_SMTP_HOST/USER/PASSWORD 환경변수가 설정되어 있지 않습니다.");
  if (!m.to.length) throw new Error("수신자가 없습니다.");
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  const info = await transport.sendMail({ from: user, to: m.to.join(", "), subject: m.subject, text: m.text, html: m.html });
  return info.messageId;
}
