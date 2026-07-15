"use client";

import { useState } from "react";
import Link from "next/link";
import { CsAdvice } from "@/app/lib/cs";

export default function CsPage() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CsAdvice | null>(null);
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
          <p className="loading-text">응대 방법을 코칭하고 있습니다...</p>
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
            {result.manualMissing ? (
              <Link href={`/cs/manual?add=${encodeURIComponent(query)}`} className="btn-primary">
                이 상황을 매뉴얼에 추가
              </Link>
            ) : (
              <button className="btn-primary" onClick={handleCopy}>
                {copied ? "복사 완료!" : "답변 초안 복사"}
              </button>
            )}
            <button className="btn-secondary" onClick={handleReset}>
              새 문의 입력
            </button>
          </div>
        </div>

        {/* ① 상황 진단 */}
        {result.situation && (
          <div className="cs-section">
            <h2 className="detail-section-title">① 상황 진단</h2>
            <div className="cs-advice">{result.situation}</div>
          </div>
        )}

        {/* ② 적용 매뉴얼·기준 (= 지금 매뉴얼은 이렇다) */}
        {result.policy && (
          <div className="cs-section">
            <h2 className="detail-section-title">② 지금 매뉴얼은</h2>
            <div className="cs-policy">{result.policy}</div>
          </div>
        )}

        {/* ③ 이렇게 행동하세요 (= 그러니 너는 이렇게) */}
        {result.approach.length > 0 && (
          <div className="cs-section">
            <h2 className="detail-section-title">③ 그러니 이렇게 행동하세요</h2>
            <ul className="cs-advice-list">
              {result.approach.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        )}

        {/* ④ 추천 답변 초안 (복붙용) */}
        <div className="cs-section">
          <div className="cs-reply-head">
            <h2 className="detail-section-title" style={{ borderBottom: "none", marginBottom: 0, paddingBottom: 0 }}>
              ④ 추천 답변 초안 <span className="cs-reply-hint">— 고객에게 보낼 문장</span>
            </h2>
            <button className="btn-secondary cs-copy-sm" onClick={handleCopy}>
              {copied ? "복사됨" : "복사"}
            </button>
          </div>
          <div className={`cs-reply ${result.manualMissing ? "cs-reply--missing" : ""}`}>
            {result.reply}
          </div>
        </div>

        {/* ⑤ 주의·리스크 */}
        {result.cautions.length > 0 && (
          <div className="cs-section">
            <h2 className="detail-section-title">⑤ 주의 · 리스크</h2>
            <ul className="cs-advice-list cs-caution-list">
              {result.cautions.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
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
      <div className="csm-head">
        <div>
          <h1 className="page-title">CS 응대 코치</h1>
        </div>
        <Link href="/cs/manual" className="btn-secondary csm-back">매뉴얼 관리</Link>
      </div>
      <div style={{ height: 24 }} />

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label className="form-label" htmlFor="query">상황 / 고객 문의</label>
          <textarea
            id="query"
            className="form-textarea"
            style={{ minHeight: 180 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`고객 문의를 붙여넣거나, 지금 상황을 직접 설명하세요.\n\n예시\n· 고객이 2번째로 녹았다고 연락왔어. 어떻게 해야 해?\n· 주문한 대구순살에서 가시가 나왔다고 해요.`}
            required
          />
        </div>

        {error && <div className="b2b-error">{error}</div>}

        <button type="submit" className="btn-primary" disabled={query.trim().length < 5}>
          조언 받기
        </button>
      </form>
    </div>
  );
}
