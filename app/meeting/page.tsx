"use client";

import { useState, useRef } from "react";
import type { Meeting } from "@/app/lib/types";
import { meetingToMarkdown } from "@/app/lib/markdown";
import MeetingTerms from "./MeetingTerms";

// 2026-08-28 개편(대표 지시): 아사나 자동 업로드(OKR 1:1)를 제거하고 단순화 —
//  정리본 + 할 일 체크리스트. 할 일은 [복사]로 하나씩 옮기고(아사나 등), 옮긴 항목은 체크로 표시한다.
//  체크 상태는 화면 전용(저장 안 함) — 정리 결과 자체가 복사해 쓰는 일회성이라 같은 원칙.

export default function MeetingPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Meeting | null>(null);
  const [copied, setCopied] = useState(false);
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);

  // 할 일 옮기기 체크리스트 — index 기준 체크·개별 복사 표시
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [copiedTodo, setCopiedTodo] = useState<number | null>(null);

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
    setChecked(new Set());

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

  async function copyTodo(i: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTodo(i);
      setTimeout(() => setCopiedTodo(null), 1500);
    } catch { setError("복사 실패 — 텍스트를 직접 선택해 복사하세요."); }
  }

  function toggleChecked(i: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  function handleReset() {
    setResult(null);
    setRawText("");
    setFileName("");
    setError("");
    setChecked(new Set());
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
    const todos = Array.isArray(result.todos) ? result.todos : [];
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

        {/* 할 일 옮기기 — [복사]로 아사나 등에 하나씩 등록하고, 옮긴 항목은 체크 */}
        {todos.length > 0 && (
          <div className="markdown-preview" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
              <strong style={{ fontSize: 16 }}>할 일 옮기기 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 13 }}>· {checked.size}/{todos.length} 옮김</span></strong>
              <span className="sm-faint" style={{ fontSize: 12 }}>[복사]로 아사나 등에 등록하고, 옮긴 항목은 체크하세요 (체크는 저장되지 않아요)</span>
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {todos.map((t, i) => {
                const done = checked.has(i);
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 8, background: done ? "var(--sm-bg-subtle)" : "transparent", border: "1px solid var(--sm-border)" }}>
                    <input type="checkbox" checked={done} onChange={() => toggleChecked(i)} style={{ width: 17, height: 17, flexShrink: 0, cursor: "pointer" }} />
                    <span style={{ flex: 1, fontSize: 15, textDecoration: done ? "line-through" : "none", color: done ? "var(--sm-text-light)" : "var(--sm-black)" }}>
                      {t.task}
                      {(t.assignee || t.deadline) && (
                        <span className="sm-faint" style={{ fontSize: 12, marginLeft: 8 }}>
                          {t.assignee || ""}{t.assignee && t.deadline ? " · " : ""}{t.deadline || ""}
                        </span>
                      )}
                    </span>
                    <button type="button" className="btn-secondary" style={{ padding: "4px 12px", fontSize: 13, whiteSpace: "nowrap" }}
                      onClick={() => copyTodo(i, t.task)}>
                      {copiedTodo === i ? "복사됨" : "복사"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 서식 렌더 — ##제목·**볼드**·불릿·구분선(복사는 마크다운 원문 그대로) */}
        <div className="markdown-preview" style={{ fontSize: 15, lineHeight: 1.8 }}>
          {(result.body || md).split("\n").map((line, i) => {
            const t = line.trim();
            if (!t) return <div key={i} style={{ height: 10 }} />;
            if (t === "---") return <hr key={i} style={{ border: "none", borderTop: "1px solid var(--sm-border)", margin: "14px 0" }} />;
            const bold = (txt: string) => txt.split(/\*\*(.+?)\*\*/g).map((seg, k) => (k % 2 ? <strong key={k}>{seg}</strong> : seg));
            if (/^##\s/.test(t)) return <div key={i} style={{ fontSize: 18, fontWeight: 800, marginTop: 16, marginBottom: 6 }}>{t.replace(/^##\s*/, "")}</div>;
            if (/^###\s/.test(t)) return <div key={i} style={{ fontSize: 16, fontWeight: 700, marginTop: 10, marginBottom: 4 }}>{t.replace(/^###\s*/, "")}</div>;
            if (/^-\s/.test(t)) return <div key={i} style={{ paddingLeft: 18, textIndent: -12 }}>{"\u00b7 "}{bold(t.replace(/^-\s*/, ""))}</div>;
            return <div key={i}>{bold(t)}</div>;
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <h1 className="page-title" style={{ marginBottom: "var(--sm-space-6)" }}>회의 정리</h1>

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
