// 상세 이미지 변환(/htmlshot) — HTML 을 헤드리스 크롬으로 렌더링해 플랫폼 규격
// (쿠팡/스마트스토어)에 맞춘 이미지 세트로 자르는 서버 로직.
//  · Vercel: @sparticuz/chromium + puppeteer-core (next.config serverExternalPackages 필수)
//  · 로컬(Windows/Mac): 설치된 Chrome/Edge 실행파일을 찾아 사용
//  · 결과 이미지는 Supabase Storage 'htmlshot' 버킷에 올리고 서명 URL 반환
//    (Vercel 응답 바디 4.5MB 제한 회피 — 이미지 세트가 수십 MB 일 수 있음)
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import type { Browser } from "puppeteer-core";
import { getCurrentModel } from "./ai-model";
import { supabaseAdmin } from "./supabase";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface HtmlshotOptions {
  html: string;
  width: number;           // 출력 폭(px) — 쿠팡 780 / 스마트스토어 860
  maxSliceHeight: number;  // 장당 최대 높이(px, 출력 기준 아님 — 렌더 px)
  splitMode: "section" | "height"; // section: 섹션마다 1장(큰 섹션만 추가 분할) / height: 높이 한도 기준
  format: "jpeg" | "png";
  quality: number;         // jpeg 만 사용 (1~100)
  scale: 1 | 2;            // deviceScaleFactor — 2면 출력 픽셀 2배(선명)
  baseUrl: string;         // 상대경로(/web/upload/...) 기준 도메인
  expand: boolean;         // 아코디언/접힘 패널 자동 펼침
  aiStatic: boolean;       // AI 정적 변환 — 탭/캐러셀 등 인터랙티브 UI를 펼친 레이아웃으로
  prompt?: string;         // AI 전처리 지시 (선택)
}

export interface HtmlshotSlice {
  url: string;    // 서명 URL (24시간)
  path: string;   // storage 경로
  width: number;  // 출력 픽셀
  height: number;
  bytes: number;
}

export interface HtmlshotResult {
  slices: HtmlshotSlice[];
  totalHeight: number;   // 렌더 전체 높이(px)
  aiNotes?: string;      // AI 전처리가 실제로 적용한 내용 요약
}

/* ── AI 전처리 ────────────────────────────────────────────────
   프롬프트(자연어)를 "변환 스펙"(제거 셀렉터 + 주입 CSS/JS)으로 해석.
   HTML 전체를 다시 쓰게 하지 않는다 — 출력이 짧아 빠르고, 원본 훼손 위험이 없다. */
interface AiTransform {
  removeSelectors: string[];
  css: string;
  js: string;
  notes: string;
}

// CSS/JS 페이로드에 JSON 을 쓰면 모델이 값 안의 따옴표·개행을 이스케이프하지 않아
// 파싱이 깨진다(실제 발생) → 이스케이프가 필요 없는 태그 블록 형식을 쓴다.
const AI_SYSTEM_BASE = `상세페이지 HTML을 이미지 캡처용으로 전처리하는 도구. 임무를 읽고
HTML 을 직접 고치는 대신 변환 스펙을 아래 4개 태그 블록으로만 반환한다. 블록 밖 텍스트·코드펜스 금지.

<REMOVE>
통째로 없앨 요소의 CSS 셀렉터, 한 줄에 하나 (없으면 비움)
</REMOVE>
<CSS>
주입할 CSS (없으면 비움)
</CSS>
<JS>
주입할 JS — 즉시 실행되는 DOM 조작 코드 (없으면 비움)
</JS>
<NOTES>
적용 내용 한 줄 요약 (한국어)
</NOTES>

규칙:
- REMOVE: HTML에 실제로 존재하는 id/class 만 사용.
- CSS: 스타일 변경(색·크기·간격·숨김·레이아웃)은 CSS 로. !important 사용 가능.
- JS: 텍스트 교체·클래스 부여·요소 삽입 등 CSS 로 안 되는 것만. try/catch 불필요(호출부가 감쌈).
- 이미지 캡처 목적이므로 애니메이션/호버 효과는 최종 정지 상태 기준으로 처리.
- 수행 불가한 지시는 건너뛰고 NOTES 에 이유를 적는다.`;

// 인터랙티브 UI 정적화 임무 — 이미지에선 클릭/스크롤이 불가능하므로 내용이 숨는 패턴을 펼친다
const AI_SYSTEM_STATIC = `

[정적 변환 임무 — 반드시 수행]
이 HTML 은 이미지로 캡처된다. 클릭·스크롤이 불가능하므로, 내용이 숨겨지는 인터랙티브 패턴을 찾아 모두 보이는 정적 레이아웃으로 바꾼다:
1. 탭(활성 탭만 보이는 구조): 모든 패널이 세로로 쌓여 보이게 한다 (display:none→block, absolute 겹침→position:static 등).
   js 로 각 패널 앞에 해당 탭 이름을 굵은 제목으로 삽입하고, 탭 버튼 줄은 숨긴다.
2. 가로 캐러셀/슬라이더(overflow 스크롤 트랙): 트랙을 flex-wrap:wrap; overflow:visible 로 바꿔 모든 카드가 격자로 보이게 하고,
   좌우 화살표·페이저는 숨긴다. 카드 폭은 2~3열이 되게 조정.
3. 아코디언/접힘 패널: 열림 상태 클래스(is-open 등)를 js 로 부여하고 max-height·opacity 제한을 해제한다.
4. 겹쳐 쌓인 이미지 스택(탭 연동 등 opacity 0 으로 숨긴 이미지): 전부 보이면 겹치므로, 각 이미지가 해당 패널 옆/아래에 자연스럽게 배치되게 하거나 대표 1장만 남긴다.
5. 클릭해야 의미 있는 UI 는 숨긴다: 확대(+)·닫기 버튼, '전체보기'류 버튼, 입력폼/검색/질문 위젯, 플로팅 버튼, 재생 컨트롤.
6. 결과 레이아웃이 겹치거나 잘리지 않게 높이·간격을 함께 보정한다.`;

// <TAG>...</TAG> 블록 추출 — 닫는 태그가 없으면 끝까지
function extractBlock(text: string, tag: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const i = text.indexOf(open);
  if (i < 0) return "";
  const j = text.indexOf(close, i + open.length);
  return (j < 0 ? text.slice(i + open.length) : text.slice(i + open.length, j)).trim();
}

export async function aiTransform(html: string, prompt: string, aiStatic: boolean): Promise<AiTransform> {
  const model = await getCurrentModel();
  const system = AI_SYSTEM_BASE + (aiStatic ? AI_SYSTEM_STATIC : "");
  const userInstruction = prompt.trim() ? `[추가 변환 지시]\n${prompt.trim()}\n\n` : "";
  const response = await anthropic.messages.create({
    model,
    max_tokens: 6000,
    system,
    messages: [
      {
        role: "user",
        content: `${userInstruction}[HTML]\n${html.slice(0, 150_000)}`,
      },
    ],
  });
  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  if (!text.includes("<CSS>") && !text.includes("<REMOVE>") && !text.includes("<JS>")) {
    throw new Error("AI 전처리 결과를 해석하지 못했습니다. 지시를 더 짧고 명확하게 적어주세요.");
  }
  return {
    removeSelectors: extractBlock(text, "REMOVE")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("<")),
    css: extractBlock(text, "CSS"),
    js: extractBlock(text, "JS"),
    notes: extractBlock(text, "NOTES"),
  };
}

/* ── 브라우저 실행 ──────────────────────────────────────────── */
function findLocalChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    // Linux (로컬 도커 등)
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 접근 불가 경로 무시 */
    }
  }
  return null;
}

// 번들 바이너리가 람다에 없을 때(파일 트레이싱 누락) 런타임에 내려받는 폴백 팩.
// ⚠️ package.json 의 @sparticuz/chromium 메이저 버전과 반드시 일치시킬 것.
const CHROMIUM_PACK_URL =
  process.env.CHROMIUM_PACK_URL ||
  "https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar";

// 람다 chromium 엔 한글 폰트가 없어 한글이 전부 빈 칸으로 렌더됨(실제 발생).
// 패키지 fonts.conf 가 /tmp/fonts 를 스캔하므로(v149에서 font() API 는 제거됨)
// 캡처 전에 한글 TTF 를 그 폴더에 내려받는다.
// 1순위 Pretendard(상세페이지 실제 서체), 실패 시 Noto Sans KR.
const KOREAN_FONT_URLS = [
  process.env.HTMLSHOT_FONT_URL,
  "https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/public/variable/PretendardVariable.ttf",
  "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf",
].filter(Boolean) as string[];

let fontReady = false; // 람다 인스턴스당 1회만 로드 (웜 호출에선 스킵)

async function ensureKoreanFont(): Promise<void> {
  if (fontReady) return;
  const dir = process.env.FONTCONFIG_PATH || "/tmp/fonts";
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = `${dir}/korean-font.ttf`;
  if (fs.existsSync(dest)) {
    fontReady = true;
    return;
  }
  for (const url of KOREAN_FONT_URLS) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100_000) throw new Error("font file too small"); // CDN 오류 응답 방지
      await fs.promises.writeFile(dest, buf);
      fontReady = true;
      return;
    } catch {
      /* 다음 후보 시도 */
    }
  }
  throw new Error("한글 폰트 로드에 실패했습니다. 잠시 후 다시 시도해주세요.");
}

async function launchBrowser(): Promise<Browser> {
  const puppeteer = await import("puppeteer-core");
  const onVercel = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_VERSION;
  if (onVercel) {
    const chromium = (await import("@sparticuz/chromium")).default;
    let executablePath: string;
    try {
      executablePath = await chromium.executablePath();
    } catch {
      // node_modules/@sparticuz/chromium/bin 이 트레이싱에서 빠진 경우 —
      // GitHub 릴리스 팩을 /tmp 로 내려받아 사용 (웜 람다에선 캐시됨)
      executablePath = await chromium.executablePath(CHROMIUM_PACK_URL);
    }
    // executablePath() 이후에 폰트 배치 — fonts.tar.br 인플레이트(/tmp/fonts 생성)와 순서 보장
    await ensureKoreanFont();
    return puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: true,
    });
  }
  const local = findLocalChrome();
  if (!local) {
    throw new Error("로컬 Chrome/Edge 를 찾지 못했습니다. CHROME_PATH 환경변수로 실행파일 경로를 지정해주세요.");
  }
  return puppeteer.launch({ executablePath: local, headless: true });
}

/* ── 캡처 파이프라인 ────────────────────────────────────────── */
function buildDocument(html: string, baseUrl: string): string {
  // 이미 완전한 문서면 base 만 주입, 아니면 골격으로 감싼다.
  const baseTag = `<base href="${baseUrl.replace(/"/g, "")}/">`;
  if (/<html[\s>]/i.test(html)) {
    if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1><meta charset="utf-8">${baseTag}`);
    return html.replace(/<html([^>]*)>/i, `<html$1><head><meta charset="utf-8">${baseTag}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}` +
    `<style>html,body{margin:0;padding:0;background:#fff}</style></head><body>${html}</body></html>`;
}

export async function captureSlices(opts: HtmlshotOptions): Promise<HtmlshotResult> {
  // AI 전처리 — 브라우저 띄우기 전에 스펙만 먼저 받아둔다
  // (정적 변환 켜짐 또는 사용자 지시가 있을 때만 호출)
  let transform: AiTransform | null = null;
  if (opts.aiStatic || (opts.prompt && opts.prompt.trim())) {
    transform = await aiTransform(opts.html, opts.prompt || "", opts.aiStatic);
  }

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: opts.width, height: 1000, deviceScaleFactor: opts.scale });

    const doc = buildDocument(opts.html, opts.baseUrl || "https://seamonster.kr");
    try {
      await page.setContent(doc, { waitUntil: "load", timeout: 25_000 });
      await page.waitForNetworkIdle({ idleTime: 700, timeout: 15_000 });
    } catch {
      /* 네트워크가 안 잠잠해져도(광고 스크립트 등) 렌더는 됐으므로 진행 */
    }

    // AI 스펙 적용 (제거 → CSS → JS)
    if (transform) {
      if (transform.removeSelectors.length) {
        await page.evaluate((sels: string[]) => {
          sels.forEach((s) => {
            try {
              document.querySelectorAll(s).forEach((el) => el.remove());
            } catch { /* 잘못된 셀렉터 무시 */ }
          });
        }, transform.removeSelectors);
      }
      if (transform.css) await page.addStyleTag({ content: transform.css });
      if (transform.js) {
        await page.evaluate((code: string) => {
          try {
            // eslint-disable-next-line no-new-func
            new Function(code)();
          } catch { /* AI JS 오류는 캡처를 막지 않는다 */ }
        }, transform.js);
      }
    }

    // 정적화: 애니메이션 정지(마퀴·게이지가 항상 같은 프레임으로 찍히게)
    await page.addStyleTag({
      content: "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}",
    });

    // 접힘 패널 펼침: max-height 0 으로 접힌 요소를 열고, 부모에 is-open 부여
    // (아코디언 열림 상태의 스타일 — 색·회전 아이콘 — 까지 따라오게)
    if (opts.expand) {
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll<HTMLElement>("body *"));
        for (const el of all) {
          const cs = window.getComputedStyle(el);
          if (cs.position === "fixed") continue; // 모달/라이트박스는 건드리지 않음
          if (cs.maxHeight === "0px" && cs.overflow.includes("hidden")) {
            el.style.setProperty("max-height", "none", "important");
            if (parseFloat(cs.opacity) === 0) el.style.setProperty("opacity", "1", "important");
            const item = el.closest<HTMLElement>('[class*="__item"], [class*="__card"], [class*="-item"], [class*="-card"]');
            if (item && !item.className.includes("is-open")) item.classList.add("is-open");
          }
        }
      });
    }

    // 지연 로드(IntersectionObserver·lazy 이미지) 트리거: 끝까지 스크롤 후 복귀
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let y = 0;
        const step = () => {
          y += 800;
          window.scrollTo(0, y);
          if (y < document.body.scrollHeight + 800) setTimeout(step, 60);
          else resolve();
        };
        step();
      });
    });
    try {
      await page.waitForNetworkIdle({ idleTime: 600, timeout: 8_000 });
    } catch { /* 계속 진행 */ }
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 400));

    // 전체 높이 + 컷 후보 경계 + 최상위 섹션 경계 수집
    const { totalHeight, boundaries, majorTops } = await page.evaluate(() => {
      const h = Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
      const set = new Set<number>();
      const push = (el: Element) => {
        const top = Math.round(el.getBoundingClientRect().top + window.pageYOffset);
        if (top > 0 && top < h) set.add(top);
      };
      document.querySelectorAll("section, [class*='-sec'], [class*='__sec'], hr").forEach(push);
      document.body.querySelectorAll(":scope > *, :scope > * > *").forEach(push);

      // 최상위 섹션: 단일 래퍼(div 하나로 감싼 구조)를 파고들어가 첫 다자식 노드의 자식들
      const skip = new Set(["SCRIPT", "STYLE", "LINK", "TEMPLATE", "META", "NOSCRIPT"]);
      let node: Element = document.body;
      let tops: number[] = [];
      for (let depth = 0; depth < 6; depth++) {
        const kids = Array.from(node.children).filter(
          (el) => !skip.has(el.tagName) && el.getBoundingClientRect().height > 8,
        );
        if (kids.length === 1) {
          node = kids[0];
          continue;
        }
        tops = kids
          .map((el) => Math.round(el.getBoundingClientRect().top + window.pageYOffset))
          .filter((t) => t > 0 && t < h);
        break;
      }
      return { totalHeight: h, boundaries: Array.from(set).sort((a, b) => a - b), majorTops: tops.sort((a, b) => a - b) };
    });
    const height = Math.min(totalHeight, 60_000); // 폭주 방지 상한
    const maxH = Math.max(1_000, opts.maxSliceHeight);

    // 그리디 분할: 시작점에서 maxH 이내의 가장 먼 경계에서 자르고, 없으면 강제 컷
    const greedyCuts = (startY: number, endY: number): Array<{ y: number; h: number }> => {
      const out: Array<{ y: number; h: number }> = [];
      let y = startY;
      while (y < endY) {
        const limit = y + maxH;
        if (limit >= endY) {
          out.push({ y, h: endY - y });
          break;
        }
        const candidates = boundaries.filter((b) => b > y + maxH * 0.4 && b <= limit);
        const cut = candidates.length ? candidates[candidates.length - 1] : limit;
        out.push({ y, h: cut - y });
        y = cut;
      }
      return out;
    };

    // 섹션 모드: 최상위 섹션마다 1장. 얇은 섹션(마퀴 바 등)은 다음 섹션에 병합,
    // 최대높이 초과 섹션만 내부 경계로 추가 분할.
    const MIN_SECTION = 500;
    let cuts: Array<{ y: number; h: number }>;
    if (opts.splitMode === "section" && majorTops.length > 0) {
      const segments: Array<{ y: number; h: number }> = [];
      let start = 0;
      for (const t of majorTops.filter((t) => t > 0 && t < height)) {
        if (t - start < MIN_SECTION) continue; // 얇으면 다음 경계까지 병합
        segments.push({ y: start, h: t - start });
        start = t;
      }
      const lastH = height - start;
      if (lastH < MIN_SECTION && segments.length) segments[segments.length - 1].h += lastH;
      else if (lastH > 0) segments.push({ y: start, h: lastH });
      cuts = segments.flatMap((s) => greedyCuts(s.y, s.y + s.h));
    } else {
      cuts = greedyCuts(0, height);
    }

    // 조각별 클립 스크린샷 (sharp 없이 분할 — captureBeyondViewport 로 뷰포트 밖도 촬영됨)
    const buffers: Array<{ buf: Buffer; h: number }> = [];
    for (const c of cuts) {
      const shot = await page.screenshot({
        clip: { x: 0, y: c.y, width: opts.width, height: c.h },
        type: opts.format,
        ...(opts.format === "jpeg" ? { quality: Math.min(100, Math.max(1, opts.quality)) } : {}),
      });
      buffers.push({ buf: Buffer.from(shot), h: c.h });
    }

    // Supabase Storage 업로드 → 서명 URL (24h)
    const slices = await uploadSlices(buffers, opts);
    return { slices, totalHeight: height, aiNotes: transform?.notes || undefined };
  } finally {
    await browser.close();
  }
}

/* ── 업로드 ─────────────────────────────────────────────────── */
async function uploadSlices(
  buffers: Array<{ buf: Buffer; h: number }>,
  opts: HtmlshotOptions,
): Promise<HtmlshotSlice[]> {
  const sb = supabaseAdmin();
  const BUCKET = "htmlshot";

  // 버킷 없으면 생성 (이미 있으면 에러 무시 — 마이그레이션 없이 동작)
  try {
    await sb.storage.createBucket(BUCKET, { public: false });
  } catch { /* already exists */ }

  const ext = opts.format === "jpeg" ? "jpg" : "png";
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = `${stamp}-${Math.random().toString(36).slice(2, 8)}`;

  const out: HtmlshotSlice[] = [];
  for (let i = 0; i < buffers.length; i++) {
    const path = `${dir}/${String(i + 1).padStart(2, "0")}.${ext}`;
    const { error: upErr } = await sb.storage.from(BUCKET).upload(path, buffers[i].buf, {
      contentType: opts.format === "jpeg" ? "image/jpeg" : "image/png",
      upsert: true,
    });
    if (upErr) throw new Error(`이미지 업로드 실패: ${upErr.message}`);
    const { data: signed, error: signErr } = await sb.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24);
    if (signErr || !signed) throw new Error(`다운로드 URL 생성 실패: ${signErr?.message || "unknown"}`);
    out.push({
      url: signed.signedUrl,
      path,
      width: opts.width * opts.scale,
      height: buffers[i].h * opts.scale,
      bytes: buffers[i].buf.length,
    });
  }

  // 7일 넘은 폴더 청소 (베스트에포트 — 실패해도 무시)
  try {
    const { data: rootDirs } = await sb.storage.from(BUCKET).list("", { limit: 100 });
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const d of rootDirs || []) {
      const ts = Date.parse(
        `${d.name.slice(0, 4)}-${d.name.slice(4, 6)}-${d.name.slice(6, 8)}T${d.name.slice(8, 10)}:${d.name.slice(10, 12)}:00Z`,
      );
      if (!isNaN(ts) && ts < cutoff) {
        const { data: files } = await sb.storage.from(BUCKET).list(d.name, { limit: 100 });
        if (files?.length) await sb.storage.from(BUCKET).remove(files.map((f) => `${d.name}/${f.name}`));
      }
    }
  } catch { /* 청소 실패는 무시 */ }

  return out;
}
