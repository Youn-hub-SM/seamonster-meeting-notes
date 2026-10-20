import type { NextConfig } from "next";

// 파도소리 전용 도메인(FACTORY_HOST, 쉼표로 여러 개) — 빌드 때 읽는다(Vercel 환경변수는 빌드에도 들어간다).
const factoryHosts = (process.env.FACTORY_HOST || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const factoryHostRe = factoryHosts.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

const nextConfig: NextConfig = {
  // 파도소리 주소에서 /favicon.ico 를 직접 요청하면(북마크·일부 브라우저) 씨몬스터 파비콘 대신 파도소리 아이콘.
  //  정적 파일이라 미들웨어(matcher 제외)로는 못 막는다 — 파일보다 먼저 도는 beforeFiles 리라이트로.
  //  대표 규칙: 파도소리 주소에서는 씨몬스터 업무도우미가 전혀 보이면 안 된다.
  async rewrites() {
    return {
      beforeFiles: factoryHostRe
        ? [{ source: "/favicon.ico", has: [{ type: "host" as const, value: `^(${factoryHostRe})$` }], destination: "/factory/icon.png" }]
        : [],
      afterFiles: [],
      fallback: [],
    };
  },
  // puppeteer-core + @sparticuz/chromium (htmlshot 상세 이미지 변환): 크롬 바이너리를
  // 웹팩이 번들하면 깨지므로 서버 외부 패키지로 제외 — Node 런타임이 직접 require.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  // Vercel 파일 트레이싱이 chromium/bin(.br 압축 바이너리)을 동적 로드라 놓침
  // → "/var/task/.../bin does not exist" 500. 라우트에 명시적으로 포함시킨다.
  outputFileTracingIncludes: {
    "/api/htmlshot/render": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/htmlshot/render/route": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
};

export default nextConfig;
