#!/usr/bin/env node
// 디자인 토큰 동기화 — app/globals.css :root(단일 소스)의 값을
// public/ 정적 HTML(iframe 도구)의 :root 로 옮겨 적는다.
//
// 왜: 정적 HTML 은 globals.css 를 import 할 수 없어 토큰 "값"이 복사돼 있다.
//     손으로 맞추면 반드시 어긋난다(실제로 #666/#999/#ED8936 등이 오래 남아 있었다).
//     이 스크립트가 있으면 globals.css 한 곳만 고쳐도 iframe 화면·차트(런타임에
//     자기 :root 를 읽음)까지 전부 따라온다.
//
// 사용:
//   node scripts/sync-design-tokens.mjs          동기화(파일 수정)
//   node scripts/sync-design-tokens.mjs --check  검사만(어긋나면 exit 1)
//   npm run build 가 이 스크립트를 먼저 실행하므로 배포 산출물은 항상 동기 상태다.
//
// 새 정적 도구를 추가하면 TARGETS 에 파일과 매핑(대상 변수 → --sm-* 토큰)을 등록할 것.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

function fail(msg) {
  console.error(`[sync-design-tokens] 오류: ${msg}`);
  process.exit(1);
}

// ── 1) 소스 토큰: app/globals.css 의 첫 :root 블록 ──
const globalsPath = resolve(ROOT, "app/globals.css");
const globals = readFileSync(globalsPath, "utf8");
const rootBlock = globals.match(/:root\s*\{([\s\S]*?)\n\}/);
if (!rootBlock) fail("app/globals.css 에서 :root 블록을 찾지 못했습니다");
const tokens = new Map();
for (const m of rootBlock[1].matchAll(/(--sm-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  tokens.set(m[1], m[2].trim());
}
if (tokens.size === 0) fail(":root 에서 --sm-* 토큰을 하나도 읽지 못했습니다");

// ── 2) 대상 파일과 매핑 (대상 :root 변수 → 소스 --sm-* 토큰) ──
const COMMON = {
  "--primary": "--sm-orange",
  "--primary-dark": "--sm-orange-hover",
  "--primary-light": "--sm-orange-light",
  "--warm": "--sm-bg-warm",
  "--bg": "--sm-bg",
  "--card": "--sm-white",
  "--text": "--sm-black",
  "--text-sub": "--sm-text-mid",
  "--text-light": "--sm-text-light",
  "--border": "--sm-border",
  "--success": "--sm-success",
  "--danger": "--sm-danger",
  "--radius": "--sm-radius",
  "--radius-card": "--sm-radius-card",
  "--radius-btn": "--sm-radius-btn",
  "--container": "--sm-container",
  "--shadow-card": "--sm-shadow-card",
};
const TARGETS = [
  {
    file: "public/utm-builder.html",
    map: {
      ...COMMON,
      "--accent": "--sm-black",
      "--radius-pill": "--sm-radius-pill",
      "--shadow-float": "--sm-shadow-float",
    },
  },
  {
    file: "public/subscription-dashboard.html",
    map: {
      ...COMMON,
      "--warning": "--sm-warning",
      "--info": "--sm-info",
      "--border-light": "--sm-border-light",
      "--bg-subtle": "--sm-bg-subtle",
      "--success-bg": "--sm-success-bg",
      "--warning-bg": "--sm-warning-bg",
      "--danger-bg": "--sm-danger-bg",
    },
  },
];

// ── 3) 대상 :root 블록 안의 선언 값만 교체 (선언 뒤 주석은 보존) ──
let drift = 0;
for (const t of TARGETS) {
  const path = resolve(ROOT, t.file);
  const src = readFileSync(path, "utf8");
  const block = src.match(/:root\s*\{[\s\S]*?\n\s*\}/);
  if (!block) fail(`${t.file}: :root 블록을 찾지 못했습니다 (구조가 바뀌었으면 이 스크립트의 매핑을 갱신하세요)`);

  let next = block[0];
  const changed = [];
  for (const [targetVar, sourceToken] of Object.entries(t.map)) {
    const value = tokens.get(sourceToken);
    if (value === undefined) fail(`globals.css :root 에 ${sourceToken} 가 없습니다 (${t.file} 의 ${targetVar} 가 참조)`);
    const re = new RegExp(`(${targetVar}\\s*:\\s*)([^;]+)(;)`);
    const hit = next.match(re);
    if (!hit) { console.warn(`[sync-design-tokens] ${t.file}: ${targetVar} 선언이 없어 건너뜁니다 (매핑 정리 필요)`); continue; }
    if (hit[2].trim() !== value) {
      changed.push(`${targetVar}: ${hit[2].trim()} -> ${value}`);
      next = next.replace(re, `$1${value}$3`);
    }
  }

  if (changed.length === 0) {
    console.log(`[sync-design-tokens] = ${t.file}: 동기화 상태 (매핑 ${Object.keys(t.map).length}개)`);
    continue;
  }
  drift += changed.length;
  if (CHECK) {
    console.error(`[sync-design-tokens] x ${t.file}: ${changed.length}개 어긋남`);
    for (const c of changed) console.error(`    ${c}`);
  } else {
    writeFileSync(path, src.replace(block[0], next));
    console.log(`[sync-design-tokens] ~ ${t.file}: ${changed.length}개 값 갱신`);
    for (const c of changed) console.log(`    ${c}`);
  }
}

if (CHECK && drift > 0) {
  console.error(`\n[sync-design-tokens] 'npm run sync-tokens' 를 실행해 동기화하세요.`);
  process.exit(1);
}
