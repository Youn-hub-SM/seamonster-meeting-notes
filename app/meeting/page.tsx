"use client";

import { useState, useRef } from "react";
import { Meeting } from "@/app/lib/types";
import { meetingToMarkdown } from "@/app/lib/markdown";
import MeetingTerms from "./MeetingTerms";

export default function MeetingPage() {
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Meeting | null>(null);
  const [copied, setCopied] = useState(false);
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 텍스트 파일만 읽는다 — 엑셀·PDF 를 떨어뜨리면 깨진 바이트가 입력창에 쏟아지므로 먼저 거른다.
  //  (브라우저가 .srt 에 MIME 을 안 주는 경우가 있어 확장자도 함께 본다)
  const TEXT_EXT = /\.(srt|txt|text|vtt|md)$/i;
  async function readFile(file: File) {
    if (!TEXT_EXT.test(file.name) && !file.type.startsWith("text/")) {
      setError(`텍스트 파일만 넣을 수 있어요 (.srt .txt) — '${file.name}' 은 지원하지 않습니다.`);
      return;
    }
    setError("");
    setFileName(file.name);
    setRawText(await file.text());
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) await readFile(file);
  }

  // 드래그 앤 드롭 — 기본 동작(파일이 새 탭에서 열림)을 막아야 드롭이 우리 쪽으로 온다.
  function onDragOver(e: React.DragEvent) { e.preventDefault(); setDragging(true); }
  function onDragLeave(e: React.DragEvent) { e.preventDefault(); setDragging(false); }
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await readFile(file);
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
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText }),
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
              {copied ? "복사 완료!" : "정리본 복사"}
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
      <h1 className="page-title" style={{ marginBottom: "var(--sm-space-6)" }}>회의록 정리</h1>

      <MeetingTerms />

      <form onSubmit={handleSubmit}>
        {/* 파일 업로드 */}
        <div className="form-group">
          <label className="form-label">파일 첨부 (srt, txt)</label>
          <div className="file-upload-area" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
            {fileName ? (
              <div className="file-attached">
                <span className="file-name">{fileName}</span>
                <button type="button" className="file-remove" onClick={handleFileClear}>
                  제거
                </button>
              </div>
            ) : (
              <label className={`file-drop${dragging ? " is-dragging" : ""}`} htmlFor="fileInput">
                <span className="file-drop-text">{dragging ? "여기에 놓으세요" : "클릭하여 파일 선택 또는 여기에 드래그"}</span>
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

        {error && <div className="b2b-error">{error}</div>}

        <button type="submit" className="btn-primary" disabled={rawText.trim().length < 10}>
          정리하기
        </button>
      </form>
    </div>
  );
}
