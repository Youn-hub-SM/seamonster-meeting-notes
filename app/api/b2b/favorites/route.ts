import { NextRequest, NextResponse } from "next/server";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { getKv, setKv } from "@/app/lib/b2b-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "b2b_auth";
type Fav = { href: string; label: string };

async function userOf(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get(COOKIE)?.value;
  return (await verifySession(token)) || resolveUserName(token) || null;
}
function clean(a: unknown): Fav[] {
  if (!Array.isArray(a)) return [];
  return a.filter((x) => x && typeof (x as Fav).href === "string").map((x) => ({ href: String((x as Fav).href), label: String((x as Fav).label || (x as Fav).href) }));
}
async function load(name: string): Promise<Fav[]> {
  try { const raw = await getKv(`fav:${name}`); return raw ? clean(JSON.parse(raw)) : []; } catch { return []; }
}

// GET — 현재 로그인 계정의 즐겨찾기 목록
export async function GET(req: NextRequest) {
  const name = await userOf(req);
  if (!name) return NextResponse.json({ ok: false, favorites: [] });
  return NextResponse.json({ ok: true, favorites: await load(name) });
}

// POST { href, label, on } 토글  또는  { favorites:[...] } 전체 저장 → 갱신된 목록 반환
export async function POST(req: NextRequest) {
  const name = await userOf(req);
  if (!name) return NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });
  const b = (await req.json()) as { href?: string; label?: string; on?: boolean; favorites?: Fav[] };
  let list = await load(name);
  if (Array.isArray(b.favorites)) {
    list = clean(b.favorites).slice(0, 50);
  } else if (b.href) {
    const href = String(b.href);
    if (b.on === false) list = list.filter((f) => f.href !== href);
    else if (!list.some((f) => f.href === href)) list.push({ href, label: String(b.label || href) });
  }
  await setKv(`fav:${name}`, JSON.stringify(list));
  return NextResponse.json({ ok: true, favorites: list });
}
