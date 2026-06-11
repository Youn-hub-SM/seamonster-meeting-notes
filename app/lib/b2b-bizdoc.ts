import Anthropic from "@anthropic-ai/sdk";

// 사업자등록증 이미지/PDF → 구조화 필드 추출 (Claude vision).
// 추출 정확도는 높지만 100%는 아니므로 호출 측에서 사용자 확인 후 저장하도록 한다.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface BizDocFields {
  name: string;       // 상호(법인명)
  biz_no: string;     // 사업자등록번호 XXX-XX-XXXXX
  ceo_name: string;   // 대표자 성명
  address: string;    // 사업장 소재지
  biz_type: string;   // 업태
  biz_item: string;   // 종목
  opened_on: string;  // 개업연월일 YYYY-MM-DD
}

const SYSTEM = `당신은 한국 사업자등록증 이미지/PDF에서 정보를 추출하는 도구입니다.
이미지를 읽고 아래 JSON 형식으로만 응답하세요. 코드블록·설명 없이 순수 JSON 한 개만.
{"name":"상호(법인명)","biz_no":"사업자등록번호","ceo_name":"대표자 성명","address":"사업장 소재지 전체 주소","biz_type":"업태","biz_item":"종목","opened_on":"개업연월일"}
규칙:
- 읽을 수 없는 항목은 빈 문자열 "". 추측·창작 금지.
- 사업자등록번호는 하이픈 포함 형식(XXX-XX-XXXXX)으로.
- 개업연월일은 YYYY-MM-DD 형식으로. 없으면 "".
- 업태/종목이 여러 개면 쉼표로 연결.
- 법인등록번호와 사업자등록번호를 혼동하지 말 것(사업자등록번호는 10자리).`;

type Block =
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

export async function extractBizDoc(base64: string, mediaType: string): Promise<BizDocFields> {
  const block: Block =
    mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg", data: base64 } };

  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [block, { type: "text", text: "이 사업자등록증의 정보를 추출해 JSON으로 응답하세요." }],
      },
    ],
  });

  const text = resp.content[0]?.type === "text" ? resp.content[0].text : "{}";
  const cleaned = text.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  let p: Partial<BizDocFields> = {};
  try {
    p = JSON.parse(cleaned);
  } catch {
    p = {};
  }
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    name: s(p.name),
    biz_no: s(p.biz_no),
    ceo_name: s(p.ceo_name),
    address: s(p.address),
    biz_type: s(p.biz_type),
    biz_item: s(p.biz_item),
    opened_on: s(p.opened_on),
  };
}
