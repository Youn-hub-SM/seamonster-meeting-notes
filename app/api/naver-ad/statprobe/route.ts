import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 임시 진단용: /stats 의 ids 인코딩 방식을 직접 비교. ?ids=a,b&mode=json|repeat|comma
// 사용 후 삭제 예정.
const BASE = "https://api.searchad.naver.com";
function sign(ts: string, method: string, path: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(`${ts}.${method}.${path}`).digest("base64");
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const ids = (sp.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const mode = sp.get("mode") || "json";
  const datePreset = sp.get("datePreset") || "last7days";
  if (!ids.length) return NextResponse.json({ ok: false, error: "ids 필요" }, { status: 400 });

  const apiKey = process.env.NAVER_AD_API_KEY || "";
  const secret = process.env.NAVER_AD_SECRET || "";
  const customerId = process.env.NAVER_AD_CUSTOMER_ID || "";
  const fields = JSON.stringify(["impCnt", "clkCnt", "salesAmt", "cpc", "ctr", "avgRnk"]);

  const qs = new URLSearchParams();
  if (mode === "json") qs.append("ids", JSON.stringify(ids));
  else if (mode === "comma") qs.append("ids", ids.join(","));
  else ids.forEach((id) => qs.append("ids", id)); // repeat
  qs.append("fields", fields);
  qs.append("datePreset", datePreset);

  const ts = String(Date.now());
  const path = "/stats";
  const url = `${BASE}${path}?${qs}`;
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Timestamp": ts,
      "X-API-KEY": apiKey,
      "X-Customer": customerId,
      "X-Signature": sign(ts, "GET", path, secret),
    },
    cache: "no-store",
  });
  const text = await res.text().catch(() => "");
  return NextResponse.json({ ok: res.ok, status: res.status, mode, sentIds: ids.length, body: text.slice(0, 1500) });
}
