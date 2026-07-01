import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/qr?data=<텍스트/URL>&format=png|svg&size=&download=1 — QR 이미지 생성(인증 필요).
//  동적 QR은 data 에 /q/{code} 짧은 URL 을 넣어 인코딩한다(목적지는 나중에 바꿔도 QR 재사용).
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const data = (sp.get("data") || "").trim();
  if (!data) return NextResponse.json({ ok: false, error: "data 가 필요합니다." }, { status: 400 });
  const format = sp.get("format") === "svg" ? "svg" : "png";
  const size = Math.min(1200, Math.max(64, Number(sp.get("size")) || 320));
  const dl = sp.get("download") === "1";
  const filename = `qr-${(sp.get("name") || "code").replace(/[^\w.-]/g, "_")}.${format}`;
  // 색상·오류보정(디자인 커스터마이즈). #RRGGBB 만 허용. 로고 삽입 시 보정레벨 H 권장.
  const hex = (v: string | null, def: string) => (v && /^#?[0-9a-fA-F]{6}$/.test(v) ? (v.startsWith("#") ? v : `#${v}`) : def);
  const dark = hex(sp.get("dark"), "#000000");
  const light = hex(sp.get("light"), "#ffffff");
  const eccRaw = (sp.get("ecc") || "").toUpperCase();
  const ecc = (["L", "M", "Q", "H"].includes(eccRaw) ? eccRaw : "M") as "L" | "M" | "Q" | "H";
  const opts = { margin: 1, width: size, color: { dark, light }, errorCorrectionLevel: ecc } as const;
  try {
    if (format === "svg") {
      const svg = await QRCode.toString(data, { type: "svg", ...opts });
      return new NextResponse(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8", ...(dl ? { "Content-Disposition": `attachment; filename="${filename}"` } : {}) } });
    }
    const buf = await QRCode.toBuffer(data, { type: "png", ...opts });
    return new NextResponse(new Uint8Array(buf), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store", ...(dl ? { "Content-Disposition": `attachment; filename="${filename}"` } : {}) } });
  } catch (e) {
    console.error("[api/qr]", e);
    return NextResponse.json({ ok: false, error: "QR 생성 실패" }, { status: 500 });
  }
}
