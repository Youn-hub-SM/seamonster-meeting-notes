import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // puppeteer-core + @sparticuz/chromium (htmlshot 상세 이미지 변환): 크롬 바이너리를
  // 웹팩이 번들하면 깨지므로 서버 외부 패키지로 제외 — Node 런타임이 직접 require.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
};

export default nextConfig;
