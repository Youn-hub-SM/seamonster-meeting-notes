import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
