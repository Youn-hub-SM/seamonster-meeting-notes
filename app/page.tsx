"use client";

import { useState, useRef } from "react";
import { Meeting } from "@/app/lib/types";
import { meetingToMarkdown } from "@/app/lib/markdown";

export default function HomePage() {
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Meeting | null>(null);
  const [copied, setCopied] = useState(false);
  const [fileName, setFileName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    const text = await file.text();
    setRawText(text);
  }

  function handleFileClear() {
    setFileName("");
    setRawText("");
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const stored = localStorage.getItem("meeting-settings");
      const settings = stored ? JSON.parse(stored) : {};

      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rawText,
          model: settings.model,
          members: settings.members,
          context: settings.context,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "오류가 발생했습니다.");
      }

      const meeting = await res.json();
      setResult(meeting);
    } catch (err) {
      setError(err instanceof Error ? err.message : "오류가 발생했습니다.");
    }
    setLoading(false);
  }

  async function handleCopy() {
    if (!result) return;
    await navigator.clipboard.writeText(meetingToMarkdown(result));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleReset() {
    setRawText("");
    setResult(null);
    setError("");
    setFileName("");
    if (fileRef.current) fileRef.current.value = "";
  }

  if (loading) {
    return (
      <div className="container">
        <div className="loading-overlay">
          <div className="spinner" />
          <p className="loading-text">AI가 회의 내용을 정리하고 있습니다...</p>
        </div>
      </div>
    );
  }

  if (result) {
    const md = meetingToMarkdown(result);
    return (
      <div className="container">
        <div className="result-header">
          <h1 className="page-title">{result.title}</h1>
          <p className="detail-date">{result.date}</p>
          <div className="result-actions">
            <button className="btn-primary" onClick={handleCopy}>
              {copied ? "복사 완료!" : "마크다운 복사"}
            </button>
            <button className="btn-secondary" onClick={handleReset}>
              새 회의록 작성
            </button>
          </div>
        </div>

        <div className="markdown-preview">
          <pre className="markdown-text">{md}</pre>
        </div>

        <details style={{ marginTop: 24 }}>
          <summary className="btn-secondary" style={{ cursor: "pointer" }}>
            원본 텍스트 보기
          </summary>
          <div className="raw-text">{result.rawText}</div>
        </details>
      </div>
    );
  }

  return (
    <div className="container">
      <h1 className="page-title">회의록 정리</h1>
      <p className="page-subtitle">
        회의 내용을 직접 입력하거나 파일을 첨부하세요
      </p>

      <form onSubmit={handleSubmit}>
        {/* 파일 업로드 */}
        <div className="form-group">
          <label className="form-label">파일 첨부 (srt, txt)</label>
          <div className="file-upload-area">
            {fileName ? (
              <div className="file-attached">
                <span className="file-name">{fileName}</span>
                <button type="button" className="file-remove" onClick={handleFileClear}>
                  제거
                </button>
              </div>
            ) : (
              <label className="file-drop" htmlFor="fileInput">
                <span className="file-drop-text">클릭하여 파일 선택 또는 여기에 드래그</span>
                <span className="file-drop-hint">.srt, .txt 파일 지원</span>
              </label>
            )}
            <input
              ref={fileRef}
              id="fileInput"
              type="file"
              accept=".srt,.txt,.text"
              onChange={handleFile}
              className="file-input-hidden"
            />
          </div>
        </div>

        {/* 텍스트 직접 입력 */}
        <div className="form-group">
          <label className="form-label" htmlFor="rawText">
            {fileName ? "파일 내용 (수정 가능)" : "또는 직접 입력"}
          </label>
          <textarea
            id="rawText"
            className="form-textarea"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder={`회의 녹취록, 메모, 대화 내용 등을 자유롭게 붙여넣으세요.\n\n타임코드가 있으면 활용하고, 없으면 흐름 순서로 정리합니다.`}
            required
          />
        </div>

        {error && (
          <p style={{ color: "#e53e3e", marginBottom: 16, fontSize: 14 }}>{error}</p>
        )}

        <button type="submit" className="btn-primary" disabled={rawText.trim().length < 10}>
          정리하기
        </button>
      </form>
    </div>
  );
}
