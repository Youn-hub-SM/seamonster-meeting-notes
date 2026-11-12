"use client";

// 광고 카피 에이전트 전용 화면 조각 — 소재 목록(보고서 카드 안) + 자료(타깃 메모·타사 레퍼런스·리뷰 수집 현황).
import { useEffect, useRef, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import type { AdIdea, AgentReport } from "@/app/lib/agents/registry";
import { qty, dateTime, dateShort } from "@/app/lib/format";
import { Md } from "./Md";

const ROWS: [keyof AdIdea, string][] = [
  ["angle", "소구점"], ["target", "대상"], ["hook", "후킹"], ["story", "스토리"], ["offer", "제안"],
  ["headline", "제목"], ["short_text", "짧은 본문"], ["primary_text", "긴 본문"], ["visual", "비주얼"], ["basis", "근거"],
];
const COUNT_LABEL: [string, string][] = [["reviews", "리뷰"], ["inquiries", "문의"], ["voc", "VOC"], ["searches", "웹 검색"], ["ads", "광고"], ["references", "레퍼런스"]];

// 보고서 카드 안 — 소재 목록 + 피드백 + 조사 요약
export function IdeasSection({ r, onChange }: { r: AgentReport; onChange: (r: AgentReport) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const copy = async (d: AdIdea) => {
    try { await navigator.clipboard.writeText([d.headline, d.short_text, d.primary_text].filter(Boolean).join("\n\n")); toast.success("제목과 본문을 복사했습니다"); }
    catch { toast.error("복사하지 못했습니다."); }
  };
  const sendFeedback = async () => {
    setErr("");
    if (!feedback.trim()) { setErr("피드백을 입력하세요."); return; }
    if (!(await confirm({ title: "피드백 보내기", body: "에이전트가 피드백대로 목록을 다시 씁니다. 지금 목록은 수정본으로 바뀝니다.", action: "피드백 보내기", danger: false }))) return;
    setBusy(true);
    try {
      const j = await (await fetch(`/api/agents/reports/${r.id}/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback }) })).json();
      if (!j.ok) throw new Error(j.error);
      setFeedback("");
      onChange(j.report);
    } catch (e) { setErr(e instanceof Error ? e.message : "피드백을 보내지 못했습니다."); }
    finally { setBusy(false); }
  };

  const counts = COUNT_LABEL.filter(([k]) => r.facts?.counts?.[k] != null).map(([k, label]) => `${label} ${qty(r.facts!.counts![k])}${k === "searches" ? "회" : "건"}`);
  const notes = r.facts?.notes || {};
  return (
    <>
      <section>
        <div className="ag-sec-title">신규 소재 {qty(r.ideas.length)}건</div>
        {counts.length > 0 && <div className="ag-note" style={{ marginBottom: "var(--sm-space-3)" }}>읽은 자료 · {counts.join(" · ")}</div>}
        {r.ideas.length === 0 ? <div className="b2b-empty">작성된 소재가 없습니다.</div> : r.ideas.map((d, i) => (
          <div key={`${i}-${d.title}`} className="ag-idea">
            <div className="ag-idea-head">
              <span className="ag-idea-no">{i + 1}</span>
              <span className="ag-idea-title">{d.title}</span>
              <span className="b2b-status-pill" style={{ background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" }}>{d.kind}</span>
              <span className="b2b-status-pill" style={{ background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" }}>{d.format}</span>
              <button type="button" className="b2b-link-btn ag-idea-copy" onClick={() => copy(d)}>문구 복사</button>
            </div>
            <dl className="ag-idea-grid">
              {ROWS.filter(([k]) => d[k]).map(([k, label]) => (
                <div key={k} className="ag-idea-row"><dt>{label}</dt><dd className={k === "primary_text" || k === "short_text" ? "is-copy" : undefined}>{d[k]}</dd></div>
              ))}
            </dl>
          </div>
        ))}

        <div className="ag-review">
          {r.facts?.revise_error && <div className="b2b-error">{r.facts.revise_error}</div>}
          {err && <div className="b2b-error">{err}</div>}
          <textarea className="b2b-input" value={feedback} onChange={(e) => setFeedback(e.target.value)} aria-label="에이전트에게 보낼 피드백" maxLength={2000}
            placeholder="예: 3번은 아이 반찬 대신 혼밥 직장인 대상으로, 할인 문구는 전부 빼기" />
          <div className="ag-review-actions">
            <button type="button" className="b2b-btn-secondary" onClick={sendFeedback} disabled={busy}>{busy ? "보내는 중" : "피드백 보내기"}</button>
          </div>
        </div>
      </section>

      {(notes.voice || notes.trend) && (
        <details className="ag-tools">
          <summary>조사 요약</summary>
          {notes.voice && <div className="ag-research"><div className="ag-sec-title">고객 목소리</div><Md text={notes.voice} /></div>}
          {notes.trend && <div className="ag-research"><div className="ag-sec-title">타깃 트렌드</div><Md text={notes.trend} /></div>}
        </details>
      )}
    </>
  );
}

// ── 자료 — 타깃 메모 · 타사 레퍼런스 · 공식몰 리뷰 수집 현황 ──
type Ref = { id: string; brand: string; channel: string | null; url: string | null; copy_text: string | null; note: string | null; images: string[]; created_by: string | null; created_at: string };
const CHANNELS = ["메타", "인스타그램", "유튜브", "네이버", "기타"];
const EMPTY = { brand: "", channel: CHANNELS[0], url: "", copy_text: "", note: "" };

export function AdMaterials() {
  const toast = useToast();
  const confirm = useConfirm();
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState("");
  const [savedBrief, setSavedBrief] = useState("");
  const [brief, setBrief] = useState("");
  const [refs, setRefs] = useState<Ref[]>([]);
  const [reviews, setReviews] = useState<{ count: number; synced_at: string | null; naver: number; naver_at: string | null }>({ count: 0, synced_at: null, naver: 0, naver_at: null });
  const xlsRef = useRef<HTMLInputElement>(null);
  const [insight, setInsight] = useState<{ text: string; updated_at: string | null; source: string | null }>({ text: "", updated_at: null, source: null });
  const [insightDraft, setInsightDraft] = useState<string | null>(null); // null = 보기, 글 = 고치는 중
  const [form, setForm] = useState(EMPTY);
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "brief" | "upload" | "add" | "naver" | "insight">("");
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/agents/ad-copy/materials", { cache: "no-store" }).then((x) => x.json()).then((j) => {
      if (!j.ok) { setErr(j.error || "자료를 불러오지 못했습니다."); return; }
      setSavedBrief(j.brief || ""); setBrief(j.brief || ""); setRefs(j.references || []); setReviews(j.reviews); setPending(j.pending || ""); if (j.insight) setInsight(j.insight);
    }).catch(() => setErr("자료를 불러오지 못했습니다.")).finally(() => setLoaded(true));
  }, []);

  const saveBrief = async () => {
    setBusy("brief");
    try {
      const j = await (await fetch("/api/agents/ad-copy/materials", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief }) })).json();
      if (!j.ok) throw new Error(j.error);
      setSavedBrief(j.brief); setBrief(j.brief);
      toast.success("타깃 메모를 저장했습니다");
    } catch (e) { toast.error(e instanceof Error ? e.message : "타깃 메모를 저장하지 못했습니다."); }
    finally { setBusy(""); }
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr(""); setBusy("upload");
    try {
      const urls: string[] = [];
      for (const f of Array.from(files).slice(0, 4 - images.length)) {
        const fd = new FormData(); fd.append("file", f);
        const j = await (await fetch("/api/agents/ad-copy/photo", { method: "POST", body: fd })).json();
        if (!j.ok) throw new Error(j.error);
        urls.push(j.url);
      }
      setImages((cur) => [...cur, ...urls].slice(0, 4));
    } catch (e) { setErr(e instanceof Error ? e.message : "이미지를 올리지 못했습니다."); }
    finally { setBusy(""); if (fileRef.current) fileRef.current.value = ""; }
  };
  const saveInsight = async () => {
    if (insightDraft == null) return;
    setBusy("insight");
    try {
      const j = await (await fetch("/api/agents/ad-copy/materials", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ insight: insightDraft }) })).json();
      if (!j.ok) throw new Error(j.error);
      setInsight(j.insight); setInsightDraft(null);
      toast.success("리뷰 분석 자료를 저장했습니다");
    } catch (e) { toast.error(e instanceof Error ? e.message : "리뷰 분석 자료를 저장하지 못했습니다."); }
    finally { setBusy(""); }
  };
  const uploadNaver = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    setBusy("naver");
    try {
      if (f.size > 4 * 1024 * 1024) throw new Error("4MB 이하 파일만 올릴 수 있습니다. 기간을 나눠 내려받으세요.");
      const fd = new FormData(); fd.append("file", f);
      const j = await (await fetch("/api/agents/ad-copy/reviews", { method: "POST", body: fd })).json();
      if (!j.ok) throw new Error(j.error);
      toast.success(`스마트스토어 리뷰 ${qty(j.saved)}건을 저장했습니다`);
      const m = await (await fetch("/api/agents/ad-copy/materials", { cache: "no-store" })).json();
      if (m.ok) setReviews(m.reviews);
    } catch (e) { toast.error(e instanceof Error ? e.message : "리뷰를 올리지 못했습니다."); }
    finally { setBusy(""); if (xlsRef.current) xlsRef.current.value = ""; }
  };
  const add = async () => {
    setErr("");
    if (!form.brand.trim()) { setErr("브랜드를 입력하세요."); return; }
    setBusy("add");
    try {
      const j = await (await fetch("/api/agents/ad-copy/materials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, images }) })).json();
      if (!j.ok) throw new Error(j.error);
      setRefs(j.references); setForm(EMPTY); setImages([]);
      toast.success("레퍼런스를 추가했습니다");
    } catch (e) { setErr(e instanceof Error ? e.message : "레퍼런스를 저장하지 못했습니다."); }
    finally { setBusy(""); }
  };
  const remove = async (ref: Ref) => {
    if (!(await confirm({ title: "레퍼런스 삭제", body: `${ref.brand} 레퍼런스가 지워집니다. 되돌릴 수 없습니다.`, action: "레퍼런스 삭제" }))) return;
    try {
      const j = await (await fetch(`/api/agents/ad-copy/materials?id=${ref.id}`, { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error);
      setRefs(j.references);
    } catch (e) { toast.error(e instanceof Error ? e.message : "레퍼런스를 지우지 못했습니다."); }
  };

  if (!loaded) return null;
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <section className="b2b-form-section" style={{ marginTop: "var(--sm-space-4)" }}>
      <div className="b2b-form-section-title">자료</div>
      {pending && <div className="sm-warn">{pending}</div>}

      <label className="b2b-field">
        <span className="b2b-field-label">타깃 메모</span>
        <textarea className="b2b-input ag-brief" value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={4000}
          placeholder="예: 5~10세 자녀를 둔 30~40대 맞벌이. 생선 손질이 번거로워 간편한 반찬을 찾는다" />
      </label>
      <div className="ag-mat-actions">
        <button type="button" className="b2b-btn-secondary" onClick={saveBrief} disabled={busy === "brief" || brief === savedBrief}>타깃 메모 저장</button>
        <input ref={xlsRef} type="file" accept=".xlsx" hidden onChange={(e) => uploadNaver(e.target.files)} />
        <button type="button" className="b2b-btn-secondary" onClick={() => xlsRef.current?.click()} disabled={busy === "naver" || !!pending}>{busy === "naver" ? "올리는 중" : "스마트스토어 리뷰 엑셀 올리기"}</button>
        <span className="ag-mat-status">
          {reviews.count > 0 ? `공식몰 리뷰 ${qty(reviews.count)}건${reviews.synced_at ? ` · 마지막 수집 ${dateTime(reviews.synced_at)}` : ""}` : "공식몰 리뷰 수집 전"}
          {" · "}
          {reviews.naver > 0 ? `스마트스토어 리뷰 ${qty(reviews.naver)}건${reviews.naver_at ? ` · 마지막 업로드 ${dateTime(reviews.naver_at)}` : ""}` : "스마트스토어 리뷰 없음"}
        </span>
      </div>

      <details className="ag-versions">
        <summary>리뷰 분석 자료{insight.updated_at ? ` · ${dateTime(insight.updated_at)}${insight.source ? ` ${insight.source}` : ""}` : ""}</summary>
        <div className="ag-insight">
          {insightDraft == null ? (
            <>
              {insight.text ? <Md text={insight.text} /> : <div className="b2b-empty">리뷰 분석 자료가 없습니다.</div>}
              <div className="ag-mat-actions"><button type="button" className="b2b-btn-secondary" onClick={() => setInsightDraft(insight.text)}>분석 자료 고치기</button></div>
            </>
          ) : (
            <>
              <textarea className="b2b-input ag-insight-edit" value={insightDraft} onChange={(e) => setInsightDraft(e.target.value)} aria-label="리뷰 분석 자료" maxLength={60000} />
              <div className="ag-mat-actions">
                <button type="button" className="b2b-btn-primary" onClick={saveInsight} disabled={busy === "insight" || insightDraft === insight.text}>{busy === "insight" ? "저장하는 중" : "분석 자료 저장"}</button>
                <button type="button" className="b2b-btn-secondary" onClick={() => setInsightDraft(null)} disabled={busy === "insight"}>고치기 취소</button>
              </div>
            </>
          )}
        </div>
      </details>

      <details className="ag-versions" open={refs.length === 0}>
        <summary>타사 레퍼런스 {qty(refs.length)}건</summary>
        <div className="ag-ref-form">
          <label className="b2b-field"><span className="b2b-field-label">브랜드</span><input className="b2b-input" value={form.brand} onChange={set("brand")} maxLength={100} /></label>
          <label className="b2b-field"><span className="b2b-field-label">본 곳</span>
            <select className="b2b-input" value={form.channel} onChange={set("channel")}>{CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          </label>
          <label className="b2b-field ag-ref-wide"><span className="b2b-field-label">링크</span><input className="b2b-input" value={form.url} onChange={set("url")} maxLength={1000} placeholder="https://" inputMode="url" /></label>
          <label className="b2b-field ag-ref-wide"><span className="b2b-field-label">광고 문구</span><textarea className="b2b-input" value={form.copy_text} onChange={set("copy_text")} maxLength={3000} /></label>
          <label className="b2b-field ag-ref-wide"><span className="b2b-field-label">메모</span><input className="b2b-input" value={form.note} onChange={set("note")} maxLength={1000} placeholder="예: 첫 3초에 조리 완성 컷, 댓글 반응 좋음" /></label>
          <div className="ag-ref-wide ag-ref-upload">
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={(e) => upload(e.target.files)} />
            <button type="button" className="b2b-btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy === "upload" || images.length >= 4}>{busy === "upload" ? "올리는 중" : "이미지 올리기"}</button>
            {images.map((u) => (
              <span key={u} className="ag-ref-thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt="올린 캡처" />
                <button type="button" className="b2b-link-btn" onClick={() => setImages((cur) => cur.filter((x) => x !== u))}>빼기</button>
              </span>
            ))}
          </div>
          {err && <div className="b2b-error ag-ref-wide">{err}</div>}
          <div className="ag-ref-wide"><button type="button" className="b2b-btn-primary" onClick={add} disabled={!!busy || !!pending}>{busy === "add" ? "추가하는 중" : "레퍼런스 추가"}</button></div>
        </div>

        {refs.map((ref) => (
          <div key={ref.id} className="ag-ref">
            <div className="ag-ref-head">
              <span className="ag-ref-brand">{ref.brand}</span>
              <span>{[ref.channel, dateShort(ref.created_at.slice(0, 10)), ref.created_by].filter(Boolean).join(" · ")}</span>
              {ref.url && <a className="sm-link" href={ref.url} target="_blank" rel="noopener noreferrer">링크 열기</a>}
              <button type="button" className="b2b-link-btn ag-foot-right" onClick={() => remove(ref)}>삭제</button>
            </div>
            {ref.copy_text && <div className="ag-ref-copy">{ref.copy_text}</div>}
            {ref.note && <div className="ag-note">{ref.note}</div>}
            {ref.images.length > 0 && (
              <div className="ag-ref-images">
                {ref.images.map((u) => (
                  <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="ag-ref-thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u} alt={`${ref.brand} 광고 캡처`} loading="lazy" />
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
      </details>
    </section>
  );
}
