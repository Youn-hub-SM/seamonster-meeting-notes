import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 임시 진단용: AD_CONVERSION_DETAIL StatReport 생성→폴링→다운로드 흐름/컬럼 파악. 사용 후 삭제.
const BASE = "https://api.searchad.naver.com";
function sign(ts: string, method: string, path: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(`${ts}.${method}.${path}`).digest("base64");
}
function headers(method: string, path: string) {
  const ts = String(Date.now());
  return {
    "Content-Type": "application/json; charset=UTF-8",
    "X-Timestamp": ts, "X-API-KEY": process.env.NAVER_AD_API_KEY || "",
    "X-Customer": process.env.NAVER_AD_CUSTOMER_ID || "",
    "X-Signature": sign(ts, method, path, process.env.NAVER_AD_SECRET || ""),
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(req: NextRequest) {
  const log: unknown[] = [];
  try {
    const sp = new URL(req.url).searchParams;
    const statDt = sp.get("statDt") || (() => { const d = new Date(Date.now() - 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
    const reportTp = sp.get("reportTp") || "AD_CONVERSION_DETAIL";

    // 1) 생성
    const createRes = await fetch(`${BASE}/stat-reports`, { method: "POST", headers: headers("POST", "/stat-reports"), body: JSON.stringify({ reportTp, statDt }), cache: "no-store" });
    const createTxt = await createRes.text();
    let job: Record<string, unknown> = {};
    try { job = JSON.parse(createTxt); } catch { /* */ }
    log.push({ step: "create", status: createRes.status, body: createTxt.slice(0, 500) });
    const jobId = job.reportJobId ?? job.id;
    if (!createRes.ok || jobId == null) return NextResponse.json({ ok: false, log }, { status: 200 });

    // 2) 폴링
    let statusVal = String(job.status || "");
    let downloadUrl = String(job.downloadUrl || "");
    for (let i = 0; i < 20; i++) {
      if (statusVal === "BUILT" || statusVal === "DONE") break;
      await sleep(1500);
      const gRes = await fetch(`${BASE}/stat-reports/${jobId}`, { headers: headers("GET", `/stat-reports/${jobId}`), cache: "no-store" });
      const g = await gRes.json().catch(() => ({}));
      statusVal = String((g as Record<string, unknown>).status || "");
      downloadUrl = String((g as Record<string, unknown>).downloadUrl || "");
      log.push({ step: "poll", i, status: statusVal, hasUrl: !!downloadUrl });
      if (statusVal === "NONE" || statusVal === "ERROR" || statusVal === "REGIST_ERROR") break;
    }

    // 3) 다운로드
    let head = ""; let rowsPreview: string[] = []; let dlStatus = 0;
    if (downloadUrl) {
      const u = new URL(downloadUrl);
      const dRes = await fetch(downloadUrl, { headers: headers("GET", u.pathname), cache: "no-store" });
      dlStatus = dRes.status;
      const text = await dRes.text();
      const lines = text.split("\n");
      head = lines[0]?.slice(0, 800) || "";
      rowsPreview = lines.slice(0, 6).map((l) => l.slice(0, 500));
    }
    // 4) 정리
    await fetch(`${BASE}/stat-reports/${jobId}`, { method: "DELETE", headers: headers("DELETE", `/stat-reports/${jobId}`) }).catch(() => {});

    return NextResponse.json({ ok: true, statDt, jobId, finalStatus: statusVal, downloadUrl: downloadUrl ? "(있음)" : "(없음)", dlStatus, colCount: rowsPreview[0] ? rowsPreview[0].split("\t").length : 0, head, rowsPreview, log });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String((err as Error)?.message || err), log }, { status: 200 });
  }
}
