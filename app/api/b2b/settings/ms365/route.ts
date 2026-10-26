import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/app/lib/admin-req";
import { extractErrorMsg } from "@/app/lib/supabase";
import { isMsConfigured, listSitePages } from "@/app/lib/msgraph";
import { getDocSources, setDocSources, resolveSources, type DocSource } from "@/app/lib/ms365-docs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Microsoft 365 문서 설정(관리자 › 설정 › 연결) — 자격은 env(화면엔 연결 여부만), 읽을 사이트 주소 목록은 kv.

// GET → { ok, configured, sources: [{url,label}] }
export async function GET() {
  try {
    return NextResponse.json({ ok: true, configured: isMsConfigured(), sources: await getDocSources() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { sources: [{url,label}] } — 관리자만. 전체 목록을 통째로 저장한다.
export async function PUT(req: NextRequest) {
  const deny = await adminOnly(req); if (deny) return deny;
  try {
    const b = (await req.json()) as { sources?: unknown };
    if (!Array.isArray(b.sources)) return NextResponse.json({ ok: false, error: "sources 배열이 필요합니다." }, { status: 400 });
    const list: DocSource[] = [];
    for (const s of b.sources) {
      const o = (s && typeof s === "object" ? s : {}) as { url?: unknown; label?: unknown };
      const url = String(o.url || "").trim();
      if (!url) continue;
      if (!/^https:\/\/[^/]+\.sharepoint\.com(\/|$)/i.test(url)) return NextResponse.json({ ok: false, error: `SharePoint 주소(https://…sharepoint.com/…)만 넣을 수 있습니다: ${url.slice(0, 60)}` }, { status: 400 });
      list.push({ url, label: String(o.label || "").trim().slice(0, 40) });
    }
    await setDocSources(list);
    return NextResponse.json({ ok: true, sources: await getDocSources() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// POST — 연결 확인: 저장된 사이트마다 해석해 드라이브 이름을 돌려준다(권한 미허용 사이트는 오류 문구).
export async function POST(req: NextRequest) {
  const deny = await adminOnly(req); if (deny) return deny;
  try {
    if (!isMsConfigured()) return NextResponse.json({ ok: false, error: "Vercel 환경 변수 MS_TENANT_ID·MS_CLIENT_ID·MS_CLIENT_SECRET 가 없습니다(docs/ms365-setup.md)." }, { status: 400 });
    const list = await resolveSources({ force: true });
    if (!list.length) return NextResponse.json({ ok: false, error: "사이트 주소를 먼저 저장하세요." }, { status: 400 });
    // 문서함 이름 + 사이트 페이지 수(매뉴얼 사이트) — 페이지 읽기가 막히면 여기서 바로 보인다
    const lines: string[] = [];
    for (const s of list) {
      if (s.error) { lines.push(`${s.label}: 실패 — ${s.error}`); continue; }
      let pages = "";
      try { const n = (await listSitePages(s.site.id)).length; pages = n ? ` · 페이지 ${n}개` : ""; } catch (e) { pages = ` · 페이지 읽기 실패(${e instanceof Error ? e.message.slice(0, 80) : "오류"})`; }
      lines.push(`${s.label}: OK (${s.drives.map((d) => d.name).join(", ") || "문서함 없음"}${pages})`);
    }
    const anyFail = list.some((s) => s.error);
    if (anyFail) return NextResponse.json({ ok: false, error: lines.join(" · ") }, { status: 502 });
    return NextResponse.json({ ok: true, detail: lines.join(" · ") });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "연결 확인 실패") }, { status: 500 });
  }
}
