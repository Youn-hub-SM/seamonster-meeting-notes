import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/app/lib/admin-req";
import { extractErrorMsg } from "@/app/lib/supabase";
import { resolveUserName } from "@/app/lib/b2b-auth";
import { getAssistantPrompt, setAssistantPrompt, getAssistantPromptMeta, DEFAULT_ASSISTANT_PROMPT } from "@/app/lib/assistant-prompt";
import { manualKnowledgeStatus } from "@/app/lib/ms365-docs";

export const dynamic = "force-dynamic";

// GET — 현재 비서 지침 + 기본값 + 셰어포인트 [비서] 페이지 탑재 현황
export async function GET() {
  try {
    const [prompt, meta, knowledge] = await Promise.all([getAssistantPrompt(), getAssistantPromptMeta(), manualKnowledgeStatus().catch((e) => ({ core: [], toc: 0, chars: 0, note: `읽기 실패: ${e instanceof Error ? e.message : String(e)}` }))]);
    return NextResponse.json({ ok: true, prompt, default: DEFAULT_ASSISTANT_PROMPT, isDefault: prompt === DEFAULT_ASSISTANT_PROMPT, meta, knowledge });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { prompt } — 빈 값이면 기본값으로 복원. 관리자만.
export async function PUT(req: NextRequest) {
  const deny = await adminOnly(req); if (deny) return deny;
  try {
    const { prompt } = (await req.json()) as { prompt?: string };
    const by = resolveUserName(req.cookies.get("b2b_auth")?.value || "") || "";
    await setAssistantPrompt(typeof prompt === "string" ? prompt : "", by);
    const current = await getAssistantPrompt();
    return NextResponse.json({ ok: true, prompt: current, isDefault: current === DEFAULT_ASSISTANT_PROMPT });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
