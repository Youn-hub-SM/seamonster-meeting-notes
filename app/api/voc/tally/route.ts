import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getTallySecret } from "@/app/lib/voc-tally";
import { VOC_CATEGORIES } from "@/app/lib/voc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/voc/tally  — Tally 폼 제출 웹훅 → VOC(source=설문) 자동 등록.
//  미들웨어 인증 예외. 서명 시크릿이 설정돼 있으면 검증.

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type TallyField = { key: string; label: string; type: string; value: unknown; options?: { id: string; text: string }[] };

// 선택지 id → 텍스트 변환, 파일은 url 배열 반환, 그 외 문자열화
function fieldValue(f: TallyField): { text: string; urls: string[] } {
  const v = f.value;
  // 파일 업로드: [{ url, name, ... }]
  if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] && "url" in (v[0] as object)) {
    return { text: "", urls: (v as { url: string }[]).map((x) => x.url).filter(Boolean) };
  }
  const resolve = (x: unknown): string => {
    if (f.options && typeof x === "string") return f.options.find((o) => o.id === x)?.text ?? x;
    return x == null ? "" : String(x);
  };
  if (Array.isArray(v)) return { text: v.map(resolve).join(", "), urls: [] };
  return { text: resolve(v), urls: [] };
}

// 라벨 → VOC 컬럼 추정
function classify(label: string): string | null {
  const l = label.toLowerCase().replace(/\s/g, "");
  if (/(유형|분류|카테고리|종류)/.test(l)) return "category";
  if (/(이름|성함|고객|연락처|전화|이메일|닉네임)/.test(l)) return "customer";
  if (/(구매처|구입처|판매처|구매한곳)/.test(l)) return "purchase_place";
  if (/(구매일|구입일|주문일)/.test(l)) return "purchase_date";
  if (/(생산일|제조일|유통기한)/.test(l)) return "production_date";
  if (/(상품|제품|품목)/.test(l)) return "product";
  if (/(사진|이미지|첨부|파일)/.test(l)) return "photos";
  if (/(내용|불편|상세|의견|문의|클레임|증상|불만|사유|설명)/.test(l)) return "content";
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();

    // 1) 서명 검증 (시크릿이 설정된 경우만)
    const secret = await getTallySecret();
    if (secret) {
      const sig = req.headers.get("tally-signature") || "";
      const expected = crypto.createHmac("sha256", secret).update(raw).digest("base64");
      const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!ok) {
        console.error("[voc/tally] 서명 불일치");
        return NextResponse.json({ ok: false, error: "서명 검증 실패" }, { status: 401 });
      }
    }

    const body = JSON.parse(raw) as { eventType?: string; data?: { submissionId?: string; fields?: TallyField[]; createdAt?: string } };
    if (body.eventType && body.eventType !== "FORM_RESPONSE") {
      return NextResponse.json({ ok: true, skipped: body.eventType });
    }
    const fields = body.data?.fields || [];
    const submissionId = body.data?.submissionId || "";

    // 2) 필드 매핑
    const row: Record<string, unknown> = { source: "설문", channel: "설문(Tally)", received_at: TODAY(), category: "기타" };
    const photos: string[] = [];
    const contentParts: string[] = [];
    const extraParts: string[] = [];

    for (const f of fields) {
      const { text, urls } = fieldValue(f);
      const col = classify(f.label || "");
      if (col === "photos" || urls.length) { photos.push(...urls); continue; }
      if (!text.trim()) continue;
      if (col === "category") {
        row.category = (VOC_CATEGORIES as readonly string[]).includes(text) ? text : "기타";
      } else if (col === "purchase_date" || col === "production_date") {
        if (DATE_RE.test(text)) row[col] = text;
      } else if (col && col !== "content") {
        row[col] = text;
      } else if (col === "content") {
        contentParts.push(text);
      } else {
        extraParts.push(`${f.label}: ${text}`); // 미매핑 항목은 내용에 보존
      }
    }
    if (photos.length) row.photos = photos;
    const content = [...contentParts, ...extraParts].join("\n").trim();
    row.content = content || "(설문 응답 — 내용 없음)"; // NOT NULL 보장

    // 3) 중복 방지(웹훅 재시도) — submissionId 를 created_by 에 기록
    if (submissionId) {
      row.created_by = `tally:${submissionId}`;
      const { data: dup } = await supabaseAdmin().from("voc").select("id").eq("created_by", row.created_by).maybeSingle();
      if (dup) return NextResponse.json({ ok: true, duplicate: true });
    } else {
      row.created_by = "tally";
    }

    const { data, error } = await supabaseAdmin().from("voc").insert(row).select("id").single();
    if (error) throw error;
    return NextResponse.json({ ok: true, id: data.id });
  } catch (err) {
    console.error("[voc/tally]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "처리 실패") }, { status: 500 });
  }
}
