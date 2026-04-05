"use client";

import { useState } from "react";

export default function CopyMarkdownButton({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button className="btn-primary" onClick={handleCopy} style={{ fontSize: 14, padding: "10px 24px" }}>
      {copied ? "복사 완료!" : "마크다운 복사"}
    </button>
  );
}
