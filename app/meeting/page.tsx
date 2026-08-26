"use client";

import { useEffect, useState, useRef } from "react";
import type { Meeting } from "@/app/lib/types";
import { meetingToMarkdown } from "@/app/lib/markdown";
import MeetingTerms from "./MeetingTerms";

// OKR 1:1 업로드(2026-08-24) — 각자 본인 녹취를 정리 → 1차 편집 → AI 가 비공개/공개 요약과
//  할 일을 분리 추출 → 본인 개인 소통방(아사나 비공개)과 공통 OKR 관리 프로젝트로 업로드.
type OkrTodo = { text: string; scope: "personal" | "okr" };
type OkrInfo = {
  member: string; ready: boolean; hasPat: boolean; hasProject: boolean; hasPersonal: boolean;
  last: { meetingDate: string; dueDate: string | null; items: { text: string; scope: string; done: boolean | null }[]; doneCount: number; knownCount: number } | null;
};

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const plusDays = (iso: string, n: number) => new Date(new Date(iso + "T00:00:00Z").getTime() + n * 86400e3).toISOString().slice(0, 10);

export default function MeetingPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Meeting | null>(null);
  const [copied, setCopied] = useState(false);
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);

  // ── 녹음 파일 전사(리턴제로) ──
  const [sttStage, setSttStage] = useState<"" | "uploading" | "transcribing">("");
  const [spkCount, setSpkCount] = useState("");

  // ── OKR 업로드 상태 ──
  const [okrInfo, setOkrInfo] = useState<OkrInfo | null>(null);
  const [okrOpen, setOkrOpen] = useState(false);
  const [okrText, setOkrText] = useState("");
  const [okrBusy, setOkrBusy] = useState<"" | "extract" | "upload">("");
  const [okrErr, setOkrErr] = useState("");
  const [privSummary, setPrivSummary] = useState("");
  const [pubSummary, setPubSummary] = useState("");
  const [todos, setTodos] = useState<OkrTodo[]>([]);
  const [extracted, setExtracted] = useState(false);
  const [meetingDate, setMeetingDate] = useState(kstToday());
  const [dueDate, setDueDate] = useState(plusDays(kstToday(), 7));
  const [uploadMsg, setUploadMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/meeting/okr", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (j.ok) setOkrInfo(j as OkrInfo); })
      .catch(() => {});
  }, []);

  const TEXT_EXT = /\.(srt|txt|text|vtt|md)$/i;
  const AUDIO_EXT = /\.(m4a|mp3|mp4|wav|flac|amr)$/i;

  async function readFile(file: File) {
    if (AUDIO_EXT.test(file.name) || file.type.startsWith("audio/")) {
      await transcribeAudio(file);
      return;
    }
    if (!TEXT_EXT.test(file.name) && !file.type.startsWith("text/")) {
      setError(`녹음 파일이나 텍스트 파일만 넣을 수 있어요 — '${file.name}' 은 지원하지 않습니다.`);
      return;
    }
    setError("");
    setFileName(file.name);
    setRawText(await file.text());
  }

  // 녹음 파일 → 화자 구분된 전사본.
  //  파일은 브라우저가 Storage 로 직접 올린다 — 서버를 거치면 요청 본문 4.5MB 제한에 걸린다(2시간 녹음은 수십MB).
  //  서버가 리턴제로에 넘긴 뒤 우리 쪽 사본은 지우고, 완료될 때까지 화면이 상태를 물어본다.
  async function transcribeAudio(file: File) {
    setError("");
    setFileName(file.name);
    setSttStage("uploading");
    let path = "";
    try {
      const prep = await fetch("/api/meeting/audio", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, size: file.size }),
      }).then((r) => r.json());
      if (!prep.ok) throw new Error(prep.error || "업로드를 준비하지 못했습니다.");
      path = prep.path;

      const up = await fetch(prep.uploadUrl, { method: "PUT", body: file });
      if (!up.ok) throw new Error("업로드에 실패했습니다. 연결을 확인하고 다시 시도해주세요.");

      setSttStage("transcribing");
      const started = await fetch("/api/meeting/transcribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, spkCount: spkCount ? Number(spkCount) : null }),
      }).then((r) => r.json());
      if (!started.ok) throw new Error(started.error || "변환을 시작하지 못했습니다.");
      path = ""; // 서버가 리턴제로에 넘기고 지웠다

      // 5초마다 확인(리턴제로 권장 주기). 최대 30분 — 2시간 녹음도 이 안에 끝난다.
      for (let i = 0; i < 360; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = await fetch(`/api/meeting/transcribe?id=${encodeURIComponent(started.id)}`, { cache: "no-store" }).then((r) => r.json());
        if (!s.ok) throw new Error(s.error || "변환 상태를 확인하지 못했습니다.");
        if (s.done) {
          setRawText(s.text || "");
          if (!s.text) setError("변환 결과가 비어 있습니다. 녹음에 음성이 담겼는지 확인해주세요.");
          setSttStage("");
          return;
        }
      }
      throw new Error("변환이 예상보다 오래 걸립니다. 잠시 후 다시 시도해주세요.");
    } catch (e) {
      if (path) {
        fetch("/api/meeting/audio", {
          method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
        }).catch(() => {});
      }
      setError(e instanceof Error ? e.message : "변환 중 오류가 발생했습니다.");
      setFileName("");
      setSttStage("");
    }
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
    setOkrOpen(false); setExtracted(false); setOkrErr(""); setUploadMsg(null);
    setPrivSummary(""); setPubSummary(""); setTodos([]);
    if (fileRef.current) fileRef.current.value = "";
  }

  function openOkr() {
    if (!result) return;
    setOkrText(meetingToMarkdown(result));
    setOkrOpen(true); setExtracted(false); setOkrErr(""); setUploadMsg(null);
  }

  async function runExtract() {
    setOkrBusy("extract"); setOkrErr("");
    try {
      const res = await fetch("/api/meeting/okr", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "extract", text: okrText }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "추출 실패");
      setPrivSummary(j.privateSummary || "");
      setPubSummary(j.publicSummary || "");
      setTodos(Array.isArray(j.todos) ? j.todos : []);
      setExtracted(true);
    } catch (e) { setOkrErr(e instanceof Error ? e.message : "추출 실패"); }
    setOkrBusy("");
  }

  async function runUpload() {
    if (!window.confirm("아사나로 업로드할까요?\n비공개 요약·개인 할 일 → 내 개인 소통방\n공개 요약·OKR 할 일 → OKR 관리 프로젝트")) return;
    setOkrBusy("upload"); setOkrErr(""); setUploadMsg(null);
    try {
      const res = await fetch("/api/meeting/okr", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "upload", meetingDate, dueDate, privateSummary: privSummary, publicSummary: pubSummary, todos }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "업로드 실패");
      setUploadMsg({ ok: true, text: `업로드 완료 — 아사나에 ${j.created}건 생성${j.failed ? ` (실패 ${j.failed}건)` : ""}${j.warning ? ` · ${j.warning}` : ""}` });
    } catch (e) { setUploadMsg({ ok: false, text: e instanceof Error ? e.message : "업로드 실패" }); }
    setOkrBusy("");
  }

  // 지난 체크인의 미완료 항목을 이번 할 일로 이월
  const undoneLast = (okrInfo?.last?.items || []).filter((i) => i.done === false);
  function carryOver(text: string, scope: string) {
    setTodos((p) => (p.some((t) => t.text === text) ? p : [...p, { text, scope: scope === "okr" ? "okr" : "personal" }]));
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
            {okrInfo?.ready && !okrOpen && (
              <button className="btn-primary" onClick={openOkr}>OKR 1:1 업로드</button>
            )}
            <button className="btn-secondary" onClick={handleReset}>
              새 회의록 작성
            </button>
          </div>
        </div>

        {!okrOpen && (
          <div className="markdown-preview">
            <pre className="markdown-text">{md}</pre>
          </div>
        )}

        {okrOpen && (
          <div style={{ display: "grid", gap: 20 }}>
            {/* 1차 편집 */}
            <div className="form-group">
              <label className="form-label">1차 편집 — 오타·문장을 다듬은 뒤 추출하세요</label>
              <textarea className="form-textarea" style={{ minHeight: 260 }} value={okrText} onChange={(e) => setOkrText(e.target.value)} />
              {!extracted && (
                <div style={{ marginTop: 10 }}>
                  <button className="btn-primary" onClick={runExtract} disabled={okrBusy === "extract"}>
                    {okrBusy === "extract" ? "추출 중..." : "요약·할 일 추출"}
                  </button>
                </div>
              )}
            </div>

            {okrErr && <div className="b2b-error">{okrErr}</div>}

            {extracted && (
              <>
                <div className="form-group">
                  <label className="form-label">비공개 요약 — 내 개인 소통방으로</label>
                  <textarea className="form-textarea" style={{ minHeight: 140 }} value={privSummary} onChange={(e) => setPrivSummary(e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">공개 요약 — OKR 관리 프로젝트로 (팀 전체 열람)</label>
                  <textarea className="form-textarea" style={{ minHeight: 120 }} value={pubSummary} onChange={(e) => setPubSummary(e.target.value)} />
                </div>

                <div className="form-group">
                  <label className="form-label">할 일 — [개인/OKR]을 눌러 목적지를 정하세요</label>
                  <div style={{ display: "grid", gap: 8 }}>
                    {todos.map((t, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <button type="button" className="btn-secondary" style={{ padding: "6px 12px", fontSize: 13, whiteSpace: "nowrap" }}
                          onClick={() => setTodos((p) => p.map((x, j) => j === i ? { ...x, scope: x.scope === "okr" ? "personal" : "okr" } : x))}>
                          {t.scope === "okr" ? "OKR" : "개인"}
                        </button>
                        <input className="form-textarea" style={{ minHeight: 0, padding: "8px 12px", flex: 1 }} value={t.text}
                          onChange={(e) => setTodos((p) => p.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} />
                        <button type="button" className="btn-secondary" style={{ padding: "6px 10px" }} aria-label="삭제"
                          onClick={() => setTodos((p) => p.filter((_, j) => j !== i))}>✕</button>
                      </div>
                    ))}
                    <div>
                      <button type="button" className="btn-secondary" style={{ padding: "6px 12px", fontSize: 13 }}
                        onClick={() => setTodos((p) => [...p, { text: "", scope: "personal" }])}>+ 할 일 추가</button>
                    </div>
                  </div>
                </div>

                {undoneLast.length > 0 && (
                  <div className="form-group">
                    <label className="form-label">지난 체크인 미완료 — 눌러서 이월</label>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {undoneLast.map((i2, k) => (
                        <button key={k} type="button" className="btn-secondary" style={{ padding: "6px 12px", fontSize: 13 }}
                          onClick={() => carryOver(i2.text, i2.scope)}>+ {i2.text}</button>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">회의일</label>
                    <input type="date" className="form-textarea" style={{ minHeight: 0, padding: "8px 12px" }} value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">다음 회의일 (할 일 마감)</label>
                    <input type="date" className="form-textarea" style={{ minHeight: 0, padding: "8px 12px" }} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                  </div>
                  <button className="btn-primary" onClick={runUpload} disabled={okrBusy === "upload" || (!privSummary.trim() && !pubSummary.trim() && todos.length === 0)}>
                    {okrBusy === "upload" ? "업로드 중..." : "아사나로 업로드"}
                  </button>
                </div>

                {uploadMsg && <div className={uploadMsg.ok ? "sm-success" : "b2b-error"}>{uploadMsg.text}</div>}
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="container">
      <h1 className="page-title" style={{ marginBottom: "var(--sm-space-6)" }}>회의록 정리</h1>

      {/* OKR 체크인 현황 — 지난 업로드의 이행률(아사나 완료 기준) */}
      {okrInfo?.ready && okrInfo.last && (
        <div className="b2b-card" style={{ marginBottom: 20, border: "1px solid var(--sm-border)", borderRadius: 10, padding: "12px 16px" }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            지난 OKR 체크인 ({okrInfo.last.meetingDate}) — 이행 {okrInfo.last.doneCount}/{okrInfo.last.knownCount}
            {okrInfo.last.knownCount > 0 && <span className="sm-faint" style={{ fontWeight: 400 }}> · {Math.round((okrInfo.last.doneCount / okrInfo.last.knownCount) * 100)}%</span>}
          </div>
          {okrInfo.last.items.some((i) => i.done === false) && (
            <div className="sm-faint" style={{ fontSize: 13, marginTop: 4 }}>
              미완료: {okrInfo.last.items.filter((i) => i.done === false).map((i) => i.text).join(" · ")}
            </div>
          )}
        </div>
      )}

      <MeetingTerms />

      <form onSubmit={handleSubmit}>
        {/* 파일 업로드 */}
        <div className="form-group">
          <label className="form-label">파일 첨부 (녹음 파일 또는 텍스트)</label>
          <div className="file-upload-area" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
            {sttStage ? (
              <div className="file-attached">
                <span className="file-name">
                  {sttStage === "uploading" ? "녹음 파일 올리는 중…" : "받아쓰는 중… 회의 길이만큼 걸립니다"}
                </span>
              </div>
            ) : fileName ? (
              <div className="file-attached">
                <span className="file-name">{fileName}</span>
                <button type="button" className="file-remove" onClick={handleFileClear}>
                  제거
                </button>
              </div>
            ) : (
              <label className={`file-drop${dragging ? " is-dragging" : ""}`} htmlFor="fileInput">
                <span className="file-drop-text">{dragging ? "여기에 놓으세요" : "클릭하여 파일 선택 또는 여기에 드래그"}</span>
                <span className="file-drop-hint">녹음 파일(.m4a .mp3 .wav)은 화자를 구분해 자동으로 받아씁니다 · 텍스트(.txt .srt .vtt)도 됩니다</span>
              </label>
            )}
            <input
              ref={fileRef}
              id="fileInput"
              type="file"
              accept=".srt,.txt,.text,.vtt,.m4a,.mp3,.mp4,.wav,.flac,.amr"
              onChange={handleFile}
              className="file-input-hidden"
              disabled={!!sttStage}
            />
          </div>
          {!sttStage && (
            <div className="sm-row" style={{ gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
              <label className="sm-faint" style={{ fontSize: 13 }} htmlFor="spkCount">참석 인원</label>
              <input
                id="spkCount" className="b2b-input" type="number" min={2} max={20}
                value={spkCount} onChange={(e) => setSpkCount(e.target.value)}
                placeholder="자동" style={{ width: 90 }}
              />
              <span className="sm-faint" style={{ fontSize: 12 }}>
                녹음 파일을 올릴 때만 씁니다. 인원을 넣으면 화자 구분이 더 정확해지고, 비우면 자동으로 추정합니다.
              </span>
            </div>
          )}
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

        <button type="submit" className="btn-primary" disabled={!!sttStage || rawText.trim().length < 10}>
          정리하기
        </button>
      </form>
    </div>
  );
}
