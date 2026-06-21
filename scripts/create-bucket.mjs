// 사업자등록증 등 업체 첨부파일용 비공개 Storage 버킷 생성 (1회성)
// 실행: node --env-file=.env.local scripts/create-bucket.mjs
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BUCKET = "company-docs";
const { data: existing } = await sb.storage.getBucket(BUCKET);
if (existing) {
  console.log(`이미 존재: ${BUCKET} (public=${existing.public})`);
} else {
  const { error } = await sb.storage.createBucket(BUCKET, {
    public: false, // 비공개 — 서명 URL로만 접근
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"],
  });
  if (error) { console.error("생성 실패:", error.message); process.exit(1); }
  console.log(`✅ 비공개 버킷 생성: ${BUCKET}`);
}
