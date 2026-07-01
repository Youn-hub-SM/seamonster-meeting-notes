"use client";

// QR 디자인 커스터마이즈 — 전경/배경색 + 가운데 로고 + 'SCAN ME' 프레임을 캔버스로 합성해 PNG 다운로드.
//  로고가 있으면 오류보정레벨 H 로 생성해 로고에 가려도 스캔되게 함. (QR 이미지는 동일 출처라 캔버스 안 오염됨)
import { useCallback, useEffect, useRef, useState } from "react";

const QR = 512;

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export default function QrDesigner({ data, name, onClose }: { data: string; name: string; onClose: () => void }) {
  const [dark, setDark] = useState("#111111");
  const [light, setLight] = useState("#ffffff");
  const [frame, setFrame] = useState(false);
  const [frameText, setFrameText] = useState("SCAN ME");
  const [logo, setLogo] = useState<string>(""); // dataURL
  const [preview, setPreview] = useState("");
  const [rendering, setRendering] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const render = useCallback(async () => {
    const canvas = canvasRef.current; if (!canvas) return;
    setRendering(true);
    try {
      const ecc = logo ? "H" : "M";
      const qrImg = await loadImg(`/api/qr?data=${encodeURIComponent(data)}&size=${QR}&dark=${encodeURIComponent(dark)}&light=${encodeURIComponent(light)}&ecc=${ecc}`);
      const pad = frame ? 40 : 0;
      const labelH = frame ? 70 : 0;
      const W = QR + pad * 2, H = QR + pad * 2 + labelH;
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d"); if (!ctx) return;
      ctx.fillStyle = light; ctx.fillRect(0, 0, W, H);
      if (frame) { ctx.strokeStyle = dark; ctx.lineWidth = 8; roundRect(ctx, 8, 8, W - 16, H - 16, 26); ctx.stroke(); }
      ctx.drawImage(qrImg, pad, pad, QR, QR);
      if (logo) {
        const lg = await loadImg(logo);
        const ls = QR * 0.22, lx = pad + (QR - ls) / 2, ly = pad + (QR - ls) / 2;
        ctx.fillStyle = light; roundRect(ctx, lx - 10, ly - 10, ls + 20, ls + 20, 14); ctx.fill();
        ctx.drawImage(lg, lx, ly, ls, ls);
      }
      if (frame) {
        ctx.fillStyle = dark; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = "bold 34px system-ui, -apple-system, sans-serif";
        ctx.fillText(frameText || "SCAN ME", W / 2, QR + pad * 2 + labelH / 2 + 2);
      }
      setPreview(canvas.toDataURL("image/png"));
    } catch { /* noop */ }
    setRendering(false);
  }, [data, dark, light, frame, frameText, logo]);

  useEffect(() => { render(); }, [render]);

  function onLogo(file: File) {
    const rd = new FileReader();
    rd.onload = () => setLogo(String(rd.result || ""));
    rd.readAsDataURL(file);
  }
  function download() {
    if (!preview) return;
    const a = document.createElement("a");
    a.href = preview; a.download = `qr-${(name || "code").replace(/[^\w.-]/g, "_")}.png`; a.click();
  }

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <div className="b2b-modal-head"><h2 className="b2b-modal-title">QR 디자인</h2><button className="b2b-modal-close" onClick={onClose}>✕</button></div>
        <div className="b2b-modal-body">
          <div className="sm-row" style={{ gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div style={{ flex: "0 0 auto" }}>
              {preview ? <img src={preview} alt="QR" width={220} height={frame ? 250 : 220} style={{ border: "1px solid var(--sm-border)", borderRadius: 8, display: "block" }} /> : <div className="b2b-loading" style={{ width: 220, height: 220 }}>생성 중…</div>}
              <canvas ref={canvasRef} style={{ display: "none" }} />
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">전경색</span>
                  <input type="color" className="b2b-input" value={dark} onChange={(e) => setDark(e.target.value)} style={{ height: 40, padding: 4 }} /></label>
                <label className="b2b-field"><span className="b2b-field-label">배경색</span>
                  <input type="color" className="b2b-input" value={light} onChange={(e) => setLight(e.target.value)} style={{ height: 40, padding: 4 }} /></label>
              </div>
              <div className="b2b-field" style={{ marginTop: 8 }}>
                <span className="b2b-field-label">가운데 로고(선택)</span>
                <div className="sm-row" style={{ gap: 8 }}>
                  <label className="b2b-btn-secondary" style={{ cursor: "pointer", fontSize: 12 }}>로고 올리기<input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) onLogo(f); e.target.value = ""; }} /></label>
                  {logo && <button className="b2b-link-btn" style={{ color: "var(--sm-danger)" }} onClick={() => setLogo("")}>제거</button>}
                </div>
                {logo && <span className="sm-faint" style={{ fontSize: 11 }}>로고 삽입 시 오류보정을 높여 스캔 안정성을 유지합니다.</span>}
              </div>
              <label className="sm-row" style={{ gap: 7, marginTop: 10, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={frame} onChange={(e) => setFrame(e.target.checked)} /> 'SCAN ME' 프레임
              </label>
              {frame && <input className="b2b-input" style={{ marginTop: 6 }} value={frameText} onChange={(e) => setFrameText(e.target.value)} placeholder="프레임 문구" />}
            </div>
          </div>
          <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 12 }}>※ 색 대비가 낮으면(전경이 밝거나 배경이 어두우면) 스캔이 안 될 수 있어요. 어두운 전경 + 밝은 배경을 권장합니다.</p>
        </div>
        <div className="b2b-modal-foot"><span /><div className="b2b-modal-foot-right">
          <button className="b2b-btn-secondary" onClick={onClose}>닫기</button>
          <button className="b2b-btn-primary" onClick={download} disabled={rendering || !preview}>PNG 다운로드</button>
        </div></div>
      </div>
    </div>
  );
}
