"use client";

// 상세 이미지 변환 — HTML 상세페이지를 쿠팡/스마트스토어용 이미지 세트로 변환.
// 서버(헤드리스 크롬)가 렌더링·분할·업로드하고, 여기서는 미리보기 + ZIP 다운로드.
import { useState } from "react";
import "./htmlshot.css";

type Preset = "coupang" | "smartstore" | "custom";

interface Slice {
  url: string;
  path: string;
  width: number;
  height: number;
  bytes: number;
}

interface RenderResult {
  slices: Slice[];
  totalHeight: number;
  aiNotes?: string;
}

const PRESET_WIDTH: Record<Exclude<Preset, "custom">, number> = {
  coupang: 780,
  smartstore: 860,
};

export default function HtmlshotPage() {
  const [html, setHtml] = useState("");
  const [preset, setPreset] = useState<Preset>("coupang");
  const [customWidth, setCustomWidth] = useState(780);
  const [maxSliceHeight, setMaxSliceHeight] = useState(8000);
  const [splitMode, setSplitMode] = useState<"section" | "height">("section");
  const [format, setFormat] = useState<"jpeg" | "png">("jpeg");
  const [quality, setQuality] = useState(88);
  const [scale, setScale] = useState<1 | 2>(1);
  const [baseUrl, setBaseUrl] = useState("https://seamonster.kr");
  const [expand, setExpand] = useState(true);
  const [aiStatic, setAiStatic] = useState(true);
  const [prompt, setPrompt] = useState("");

  const [loading, setLoading] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RenderResult | null>(null);

  const width = preset === "custom" ? customWidth : PRESET_WIDTH[preset];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/htmlshot/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html, width, maxSliceHeight, splitMode, format, quality, scale, baseUrl, expand, aiStatic, prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "변환에 실패했습니다.");
      setResult(data as RenderResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "변환에 실패했습니다.");
    }
    setLoading(false);
  }

  async function handleZip() {
    if (!result) return;
    setZipping(true);
    setError("");
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const ext = format === "jpeg" ? "jpg" : "png";
      for (let i = 0; i < result.slices.length; i++) {
        const res = await fetch(result.slices[i].url);
        if (!res.ok) throw new Error(`이미지 ${i + 1} 다운로드에 실패했습니다.`);
        zip.file(`${String(i + 1).padStart(2, "0")}.${ext}`, await res.blob());
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `상세이미지_${width}px_${result.slices.length}장.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ZIP 생성에 실패했습니다.");
    }
    setZipping(false);
  }

  return (
    <div className="b2b-container">
      <div className="b2b-page-head">
        <h1 className="b2b-page-title">상세 이미지 변환</h1>
        <p className="b2b-page-subtitle">코드형 상세 HTML → 플랫폼 업로드용 이미지 세트</p>
      </div>

      {error && <div className="b2b-error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="hs-grid">
          <div className="b2b-form-section">
            <div className="b2b-form-section-title">HTML</div>
            <div className="b2b-field">
              <textarea
                className="b2b-input hs-html-input"
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                placeholder="상세페이지 HTML 전체를 붙여넣기 (detail_desc_embed.html 등)"
              />
            </div>
            <div className="b2b-field">
              <label className="b2b-field-label">AI 변환 지시 (선택)</label>
              <textarea
                className="b2b-input hs-prompt-input"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder='예) "비교하기 섹션은 빼고, 레시피는 안 보이게. FAQ 글자를 조금 키워줘"'
              />
            </div>
          </div>

          <div className="b2b-form-section">
            <div className="b2b-form-section-title">출력 규격</div>

            <div className="b2b-field">
              <label className="b2b-field-label">플랫폼</label>
              <div className="sm-tabs">
                <button type="button" className={`sm-tab ${preset === "coupang" ? "is-active" : ""}`} onClick={() => setPreset("coupang")}>
                  쿠팡 (780px)
                </button>
                <button type="button" className={`sm-tab ${preset === "smartstore" ? "is-active" : ""}`} onClick={() => setPreset("smartstore")}>
                  스마트스토어 (860px)
                </button>
                <button type="button" className={`sm-tab ${preset === "custom" ? "is-active" : ""}`} onClick={() => setPreset("custom")}>
                  직접 입력
                </button>
              </div>
            </div>

            <div className="hs-opt-row">
              {preset === "custom" && (
                <div className="b2b-field">
                  <label className="b2b-field-label">폭 (px)</label>
                  <input type="number" className="b2b-input" min={300} max={1600} value={customWidth}
                    onChange={(e) => setCustomWidth(parseInt(e.target.value) || 780)} />
                </div>
              )}
              <div className="b2b-field">
                <label className="b2b-field-label">분할 방식</label>
                <select className="b2b-input" value={splitMode} onChange={(e) => setSplitMode(e.target.value === "height" ? "height" : "section")}>
                  <option value="section">섹션마다 1장</option>
                  <option value="height">최대 높이 기준</option>
                </select>
              </div>
              <div className="b2b-field">
                <label className="b2b-field-label">장당 최대 높이 (px)</label>
                <input type="number" className="b2b-input" min={1000} max={20000} step={500} value={maxSliceHeight}
                  onChange={(e) => setMaxSliceHeight(parseInt(e.target.value) || 8000)} />
              </div>
              <div className="b2b-field">
                <label className="b2b-field-label">형식</label>
                <select className="b2b-input" value={format} onChange={(e) => setFormat(e.target.value as "jpeg" | "png")}>
                  <option value="jpeg">JPG</option>
                  <option value="png">PNG</option>
                </select>
              </div>
              {format === "jpeg" && (
                <div className="b2b-field">
                  <label className="b2b-field-label">JPG 품질</label>
                  <input type="number" className="b2b-input" min={40} max={100} value={quality}
                    onChange={(e) => setQuality(parseInt(e.target.value) || 88)} />
                </div>
              )}
              <div className="b2b-field">
                <label className="b2b-field-label">해상도</label>
                <select className="b2b-input" value={scale} onChange={(e) => setScale(e.target.value === "2" ? 2 : 1)}>
                  <option value={1}>1배</option>
                  <option value={2}>2배 (선명, 용량 큼)</option>
                </select>
              </div>
            </div>

            <div className="b2b-field">
              <label className="b2b-field-label">이미지 기준 도메인</label>
              <input type="text" className="b2b-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </div>

            <label className="b2b-checkbox">
              <input type="checkbox" checked={expand} onChange={(e) => setExpand(e.target.checked)} />
              접힌 아코디언·패널 모두 펼쳐서 캡처
            </label>
            <label className="b2b-checkbox">
              <input type="checkbox" checked={aiStatic} onChange={(e) => setAiStatic(e.target.checked)} />
              AI 정적 변환 — 탭·캐러셀 등 숨은 내용을 모두 펼친 레이아웃으로 재구성
            </label>

            <div className="b2b-form-foot">
              <button type="submit" className="b2b-btn-primary" disabled={loading}>
                {loading ? "변환 중..." : "이미지로 변환"}
              </button>
            </div>
          </div>
        </div>
      </form>

      {loading && <div className="b2b-loading">렌더링하고 자르는 중입니다 (최대 1분)...</div>}

      {result && (
        <div className="b2b-form-section">
          <div className="b2b-form-section-title">결과 — {result.slices.length}장 (전체 높이 {result.totalHeight.toLocaleString()}px)</div>
          {result.aiNotes && <div className="sm-success">AI 전처리: {result.aiNotes}</div>}
          <div className="hs-result-actions">
            <button type="button" className="b2b-btn-primary" onClick={handleZip} disabled={zipping}>
              {zipping ? "압축 중..." : "전체 ZIP 다운로드"}
            </button>
            <span className="sm-faint">다운로드 링크는 24시간 뒤 만료됩니다 — 필요한 이미지는 바로 저장해두세요.</span>
          </div>
          <div className="hs-result-list">
            {result.slices.map((s, i) => (
              <div key={s.path} className="hs-result-card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt={`이미지 ${i + 1}`} className="hs-result-thumb" loading="lazy" />
                <div className="hs-result-meta">
                  <span>{i + 1}번 · {s.width}×{s.height}</span>
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="sm-link" download>
                    저장
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
