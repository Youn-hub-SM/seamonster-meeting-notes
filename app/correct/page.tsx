"use client";

import { useState } from "react";
import { CorrectionResult } from "@/app/lib/correct";

function resultToMarkdown(r: CorrectionResult): string {
  const lines: string[] = [];

  lines.push("# 교정 결과");
  lines.push("");
  r.corrections.forEach((c, i) => {
    lines.push(`${i + 1}. 수정할 문장: ${c.original}`);
    lines.push(`   수정된 문장: ${c.corrected}`);
    lines.push("");
  });

  lines.push("# 분석 및 피드백");
  lines.push("");
  lines.push(`**수정 이유 요약:** ${r.analysis.summary}`);
  lines.push("");
  if (r.analysis.customerPerspective.length > 0) {
    lines.push("**고객 관점/전달력:**");
    r.analysis.customerPerspective.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }
  if (r.analysis.toneViolations.length > 0) {
    lines.push("**톤앤매너 위배:**");
    r.analysis.toneViolations.forEach((t) => lines.push(`- ${t}`));
    lines.push("");
  }
  if (r.analysis.grammarRules.length > 0) {
    lines.push("**맞춤법/표현 교정:**");
    r.analysis.grammarRules.forEach((g) => lines.push(`- ${g}`));
    lines.push("");
  }

  lines.push("# 카피라이터의 한 줄 팁");
  lines.push("");
  lines.push(r.tip);

  return lines.join("\n");
}

export default function CorrectPage() {
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CorrectionResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText }),
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
    await navigator.clipboard.writeText(resultToMarkdown(result));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleReset() {
    setRawText("");
    setResult(null);
    setError("");
  }

  if (loading) {
    return (
      <div className="container">
        <div className="loading-overlay">
          <div className="spinner" />
          <p className="loading-text">문장을 교정하고 있습니다...</p>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div className="container">
        <div className="result-header">
          <h1 className="page-title">교정 결과</h1>
          <div className="result-actions">
            <button className="btn-primary" onClick={handleCopy}>
              {copied ? "복사 완료!" : "마크다운 복사"}
            </button>
            <button className="btn-secondary" onClick={handleReset}>
              새 교정 요청
            </button>
          </div>
        </div>

        {/* 교정 결과 */}
        <div className="correct-section">
          <h2 className="detail-section-title">교정 결과</h2>
          {result.corrections.map((c, i) => (
            <div key={i} className="correct-item">
              <div className="correct-original">
                <span className="correct-label correct-label--before">수정 전</span>
                {c.original}
              </div>
              <div className="correct-arrow">&#8595;</div>
              <div className="correct-corrected">
                <span className="correct-label correct-label--after">수정 후</span>
                {c.corrected}
              </div>
            </div>
          ))}
        </div>

        {/* 분석 */}
        <div className="correct-section">
          <h2 className="detail-section-title">분석 및 피드백</h2>
          <div className="correct-analysis">
            <div className="analysis-item">
              <strong>수정 이유 요약</strong>
              <p>{result.analysis.summary}</p>
            </div>
            {result.analysis.customerPerspective.length > 0 && (
              <div className="analysis-item">
                <strong>고객 관점/전달력</strong>
                <ul>
                  {result.analysis.customerPerspective.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {result.analysis.toneViolations.length > 0 && (
              <div className="analysis-item">
                <strong>톤앤매너 위배</strong>
                <ul>
                  {result.analysis.toneViolations.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            )}
            {result.analysis.grammarRules.length > 0 && (
              <div className="analysis-item">
                <strong>맞춤법/표현 교정</strong>
                <ul>
                  {result.analysis.grammarRules.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        {/* 팁 */}
        <div className="correct-section">
          <h2 className="detail-section-title">카피라이터의 한 줄 팁</h2>
          <div className="correct-tip">{result.tip}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <h1 className="page-title">문장 교정</h1>
      <p className="page-subtitle">
        씨몬스터 톤앤매너에 맞게 문장을 교정합니다
      </p>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label className="form-label" htmlFor="rawText">교정할 문장</label>
          <textarea
            id="rawText"
            className="form-textarea"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder={`교정할 문장을 입력하세요.\n\n예시:\n신선한 바다의 맛을 그대로 담아낸 프리미엄 순살 생선으로,\n건강한 식탁이 만들어집니다.`}
            required
          />
        </div>

        {error && (
          <p style={{ color: "#e53e3e", marginBottom: 16, fontSize: 14 }}>{error}</p>
        )}

        <button type="submit" className="btn-primary" disabled={rawText.trim().length < 5}>
          교정하기
        </button>
      </form>
    </div>
  );
}
