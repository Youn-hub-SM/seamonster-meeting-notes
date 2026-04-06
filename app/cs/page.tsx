"use client";

import { useState } from "react";
import { CsResult } from "@/app/lib/cs";

export default function CsPage() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CsResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/cs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "오류가 발생했습니다.");
      }

      const data = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "오류가 발생했습니다.");
    }
    setLoading(false);
  }

  async function handleCopy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.reply);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleReset() {
    setQuery("");
    setResult(null);
    setError("");
  }

  if (loading) {
    return (
      <div className="container">
        <div className="loading-overlay">
          <div className="spinner" />
          <p className="loading-text">답변을 생성하고 있습니다...</p>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div className="container">
        <div className="result-header">
          <div className="cs-category-badge" data-missing={result.manualMissing}>
            {result.category}
          </div>
          <div className="result-actions">
            <button className="btn-primary" onClick={handleCopy}>
              {copied ? "복사 완료!" : "답변 복사"}
            </button>
            <button className="btn-secondary" onClick={handleReset}>
              새 문의 입력
            </button>
          </div>
        </div>

        <div className="cs-section">
          <h2 className="detail-section-title">고객 답변</h2>
          <div className={`cs-reply ${result.manualMissing ? "cs-reply--missing" : ""}`}>
            {result.reply}
          </div>
        </div>

        {result.internalNote && (
          <div className="cs-section">
            <h2 className="detail-section-title">내부 참고</h2>
            <div className="cs-internal">{result.internalNote}</div>
          </div>
        )}

        <details style={{ marginTop: 24 }}>
          <summary className="btn-secondary" style={{ cursor: "pointer" }}>
            원본 문의 보기
          </summary>
          <div className="raw-text">{query}</div>
        </details>
      </div>
    );
  }

  return (
    <div className="container">
      <h1 className="page-title">CS 답변 생성</h1>
      <p className="page-subtitle">
        고객 문의를 입력하면 매뉴얼 기반 답변 초안을 생성합니다
      </p>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label className="form-label" htmlFor="query">고객 문의 내용</label>
          <textarea
            id="query"
            className="form-textarea"
            style={{ minHeight: 180 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`고객 문의 내용을 붙여넣으세요.\n\n예시:\n주문한 대구순살에서 가시가 나왔어요. 아이가 먹다가 발견했는데 너무 놀랐습니다.`}
            required
          />
        </div>

        {error && (
          <p style={{ color: "#e53e3e", marginBottom: 16, fontSize: 14 }}>{error}</p>
        )}

        <button type="submit" className="btn-primary" disabled={query.trim().length < 5}>
          답변 생성
        </button>
      </form>
    </div>
  );
}
