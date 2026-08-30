"use client";

// 월간 VOC 리포트 — AI 초안 생성 + (월, 수신 제조사) 단위 자동 저장(086) + 손해 청구 섹션.
//  · 생성/편집하면 자동 저장되고, 화면을 다시 열면 저장본을 바로 불러온다(재생성 불필요).
//  · 제조사명을 넣으면 개선요청서와 같은 기준(제조사 귀책·설문 제외)의 손해 청구 정리가
//    인쇄 미리보기에 붙고, Word 다운로드에도 같은 내용이 텍스트 섹션으로 들어간다.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { buildManufacturerReport } from "@/app/lib/voc-manufacturer";
import type { Voc } from "@/app/lib/voc";

const THIS_MONTH = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7); // KST
const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const won = (n: number) => Math.round(n).toLocaleString();

type SavedReport = { recipient: string; draft: string; counts: { claims: number; surveys: number } | null; updated_at: string };

export default function VocManufacturerPage() {
  const [month, setMonth] = useState(THIS_MONTH());
  const [recipient, setRecipient] = useState("");
  const [draft, setDraft] = useState("");
  const [counts, setCounts] = useState<{ claims: number; surveys: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // 저장/불러오기 상태
  const [savedReports, setSavedReports] = useState<SavedReport[]>([]);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [claims, setClaims] = useState<Voc[]>([]);
  const [needsMigration, setNeedsMigration] = useState(false);
  const [saveNote, setSaveNote] = useState("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedKey = useRef(""); // "month|recipient" — 자동 저장은 저장본을 불러왔거나 생성한 뒤에만

  // 월이 바뀌면: 그 달의 저장 리포트·클레임을 불러오고, 저장본이 있으면 초안을 바로 채운다.
  useEffect(() => {
    let alive = true;
    (async () => {
      setError(""); setSaveNote("");
      try {
        const res = await fetch(`/api/voc/manufacturer/reports?month=${month}`, { cache: "no-store" });
        const j = await res.json();
        if (!alive || !j?.ok) return;
        setSavedReports(j.reports || []);
        setRecipients(j.recipients || []);
        setClaims(j.claims || []);
        setNeedsMigration(!!j.needsMigration);
        const list = (j.reports || []) as SavedReport[];
        // 현재 수신처와 일치하는 저장본 우선, 없으면 가장 최근 저장본
        const pick = list.find((r) => r.recipient === recipient) || list[0];
        if (pick) {
          setDraft(pick.draft); setCounts(pick.counts || null);
          if (pick.recipient && !recipient) setRecipient(pick.recipient);
          loadedKey.current = `${month}|${pick.recipient}`;
          setSaveNote(`저장본 불러옴 (${pick.updated_at.slice(0, 16).replace("T", " ")})`);
        } else {
          setDraft(""); setCounts(null); loadedKey.current = "";
        }
      } catch { /* 저장 기능 없이도 생성은 가능 */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  // 수신처를 바꿨을 때 그 수신처의 저장본이 있으면 전환해서 보여준다(편집 중이던 다른 수신처 본문은 이미 자동 저장됨).
  function onRecipientChange(v: string) {
    setRecipient(v);
    const pick = savedReports.find((r) => r.recipient === v);
    if (pick) {
      setDraft(pick.draft); setCounts(pick.counts || null);
      loadedKey.current = `${month}|${v}`;
      setSaveNote(`저장본 불러옴 (${pick.updated_at.slice(0, 16).replace("T", " ")})`);
    } else if (loadedKey.current) {
      // 수신처만 바뀐 새 문서 취급 — 기존 본문 유지(같은 달 다른 제조사로 보낼 때 복제해 편집하는 흐름)
      loadedKey.current = `${month}|${v}`;
    }
  }

  async function persist(text: string, rcpt: string, cts: typeof counts) {
    try {
      const res = await fetch("/api/voc/manufacturer/reports", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, recipient: rcpt, draft: text, counts: cts }),
      });
      const j = await res.json().catch(() => null);
      if (j?.needsMigration) { setNeedsMigration(true); setSaveNote(""); return; }
      if (!res.ok || !j?.ok) throw new Error(j?.error || "저장 실패");
      setSaveNote(`자동 저장됨 ${new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16)}`);
      setSavedReports((prev) => {
        const rest = prev.filter((r) => r.recipient !== rcpt);
        return [{ recipient: rcpt, draft: text, counts: cts, updated_at: new Date().toISOString() }, ...rest];
      });
      if (rcpt && !recipients.includes(rcpt)) setRecipients((p) => [...p, rcpt].sort((a, b) => a.localeCompare(b, "ko")));
    } catch (e) { setSaveNote(`저장 실패: ${e instanceof Error ? e.message : ""}`); }
  }

  // 편집 자동 저장(1.5초 디바운스) — 생성했거나 저장본을 불러온 문서만
  function onDraftChange(text: string) {
    setDraft(text);
    if (!loadedKey.current || needsMigration) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { if (text.trim()) persist(text, recipient, counts); }, 1500);
  }

  async function generate() {
    setLoading(true); setError(""); setCopied(false);
    try {
      const res = await fetch("/api/voc/manufacturer/digest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month }) });
      // 함수가 시간 초과 등으로 끊기면 Vercel 이 JSON 아닌 텍스트("An error occurred…")를 내려보낸다
      //  → 무조건 res.json() 하면 "Unexpected token 'A'…" 파싱 오류만 보였다. 텍스트로 받고 직접 판별.
      const raw = await res.text();
      let j: { ok?: boolean; draft?: string; counts?: { claims: number; surveys: number }; error?: string } | null = null;
      try { j = JSON.parse(raw); } catch { /* 플랫폼 오류 텍스트 */ }
      if (!j) throw new Error(`서버가 응답을 완성하지 못했습니다 (HTTP ${res.status}). 데이터가 많은 달은 AI 생성이 제한시간을 넘길 수 있어요 — 잠시 후 다시 시도하거나, 관리자 > 설정 > AI 설정에서 'VOC 인사이트' 모델을 빠른 모델로 바꿔보세요.`);
      if (!res.ok || !j.ok) throw new Error(j.error || "초안 생성 실패");
      const text = j.draft || "";
      setDraft(text);
      setCounts(j.counts || null);
      loadedKey.current = `${month}|${recipient}`;
      if (!needsMigration && text.trim()) persist(text, recipient, j.counts || null); // 생성 즉시 자동 저장
    } catch (e) { setError(e instanceof Error ? e.message : "초안 생성 실패"); }
    setLoading(false);
  }

  async function copy() {
    try { await navigator.clipboard.writeText(draft); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setError("복사 실패 — 텍스트를 직접 선택해 복사하세요."); }
  }

  // ── 손해 청구 섹션 (개선요청서와 동일 기준: 제조사 귀책 · 설문 제외 · 해당 월) ──
  //  제조사가 현재 한 곳뿐이라 제조사명 입력과 무관하게 항상 포함한다(이름은 수신 표기용).
  const mfg = useMemo(() => buildManufacturerReport(claims, month), [claims, month]);
  const showClaim = !!draft;

  // Word 용 텍스트 섹션 — 초안과 같은 구조("숫자. / 가. / - 불릿")라 docx 변환기가 그대로 서식화한다.
  const claimText = useMemo(() => {
    if (!showClaim) return "";
    const L: string[] = ["", "3. 손해 청구 (제조사 귀책)"];
    if (!mfg.summary.count) { L.push("- 해당 없음"); return L.join("\n"); }
    L.push(`- 총 ${mfg.summary.count}건 · 청구 손해액 ${won(mfg.summary.claimable)}원 · 대상 제품 ${mfg.summary.productCount}종`);
    L.push("가. 제품별");
    for (const p of mfg.byProduct) L.push(`- ${p.product}: ${p.count}건 · ${won(p.claimable)}원 (${p.categories.map(([c, n]) => `${c} ${n}`).join(" · ")})`);
    L.push("나. 접수 상세");
    // 내용은 자르지 않는다 — 제조사에 보내는 문서라 문장이 중간에 끊기면 안 됨(줄바꿈만 공백으로)
    for (const r of mfg.items) L.push(`- ${(r.received_at || "").slice(5)} ${r.product || "-"} · ${r.category} · ${won(r.loss_amount || 0)}원${r.content ? ` — ${String(r.content).replace(/\s*\n+\s*/g, " ")}` : ""}`);
    return L.join("\n");
  }, [showClaim, mfg]);

  async function downloadDocx() {
    setError("");
    try {
      const body = { month, recipient, draft: claimText ? `${draft.trimEnd()}\n${claimText}` : draft };
      const res = await fetch("/api/voc/manufacturer/docx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error((j as { error?: string }).error || "Word 생성 실패"); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `씨몬스터_고객반응_${month}.docx`; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : "Word 생성 실패"); }
  }

  const [y, mm] = month.split("-");
  const exportUrl = `/api/voc/manufacturer/export?month=${month}${recipient ? `&recipient=${encodeURIComponent(recipient)}` : ""}`;
  const cellTh: React.CSSProperties = { textAlign: "left", padding: "7px 8px", borderBottom: "2px solid var(--sm-black)", fontSize: 12, whiteSpace: "nowrap" };
  const cellTd: React.CSSProperties = { padding: "7px 8px", borderBottom: "1px solid var(--sm-border)", fontSize: 15, verticalAlign: "top" };
  const num: React.CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <div className="b2b-container">
      <header className="b2b-page-head no-print">
        <div>
          <h1 className="b2b-page-title">월간 VOC 리포트</h1>
        </div>
        <div className="b2b-page-actions">
          <a className="b2b-btn-secondary" href={exportUrl} title="제조사 귀책 건수·청구 손해액(정산용)">정산 데이터(엑셀)</a>
          <button className="b2b-btn-secondary" onClick={downloadDocx} disabled={!draft}>Word 다운로드</button>
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={!draft}>인쇄 / PDF</button>
        </div>
      </header>

      {error && <div className="b2b-error no-print">{error}</div>}
      {needsMigration && <div className="sm-warn no-print" style={{ marginBottom: 12 }}>자동 저장을 쓰려면 마이그레이션 086(voc_monthly_reports)을 적용하세요. 적용 전에도 생성·인쇄는 됩니다.</div>}

      <section className="b2b-card no-print" style={{ marginBottom: 16 }}>
        <div className="sm-row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>대상 월
            <input className="b2b-input" type="month" value={month} max={THIS_MONTH()} onChange={(e) => setMonth(e.target.value)} style={{ width: "auto" }} /></label>
          <input className="b2b-input" list="voc-mfg-recipients" value={recipient} onChange={(e) => onRecipientChange(e.target.value)} placeholder="수신 제조사명 (선택 · 문서에 표기)" style={{ width: 220 }} />
          <datalist id="voc-mfg-recipients">{recipients.map((r) => <option key={r} value={r} />)}</datalist>
          <button className="b2b-btn-primary" onClick={generate} disabled={loading}>{loading ? "AI 작성 중..." : draft ? "다시 생성" : "AI 초안 생성"}</button>
          {counts && <span className="sm-faint" style={{ fontSize: 12 }}>클레임 {counts.claims}건 · 설문 {counts.surveys}건 반영</span>}
          {saveNote && <span className="sm-faint" style={{ fontSize: 12, color: saveNote.startsWith("저장 실패") ? "var(--sm-danger)" : undefined }}>{saveNote}</span>}
        </div>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>※ 클레임(VOC)·설문(Tally)을 긍정/부정·제품별로 정리합니다(리뷰 섹션 제외). 생성·편집하면 자동 저장되어 다시 열면 그대로 이어집니다. 손해 청구(제조사 귀책) 정리가 문서 끝에 항상 붙고, 제조사명은 수신 표기에 쓰입니다.</p>
      </section>

      {/* 편집 (화면 전용) */}
      {draft && (
        <section className="b2b-card no-print" style={{ marginBottom: 16 }}>
          <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="b2b-card-title">초안 편집</span>
            <button className="b2b-btn-secondary" onClick={copy} style={{ padding: "4px 12px", fontSize: 15 }}>{copied ? "✓ 복사됨" : "텍스트 복사"}</button>
          </div>
          <textarea className="b2b-textarea" value={draft} onChange={(e) => onDraftChange(e.target.value)} rows={22}
            style={{ width: "100%", fontSize: 15, lineHeight: 1.7, fontFamily: "inherit" }} />
        </section>
      )}

      {/* 출력 미리보기 (인쇄 대상) */}
      {draft ? (
        <section className="voc-print" style={{ background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 12, padding: "32px 34px", maxWidth: 860, boxShadow: "var(--sm-shadow-card)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid var(--sm-black)", paddingBottom: 12, marginBottom: 18 }}>
            <div><div style={{ fontSize: 15, color: "var(--sm-text-mid)", fontWeight: 700 }}>씨몬스터</div><h2 style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{y}년 {Number(mm)}월 고객 반응</h2></div>
            <div style={{ textAlign: "right", fontSize: 12, color: "var(--sm-text-mid)" }}>작성일 {TODAY()}{recipient && <div>수신 · {recipient}</div>}</div>
          </div>
          {/* 줄 단위 서식 — 제목(1./2.)·소제목(가./나.)·분류 라벨을 크게·볼드로(2026-08-28 대표 지시, 가독성) */}
          <div style={{ fontSize: 15, lineHeight: 1.75 }}>
            {draft.replace(/^\s*\d{4}년\s*\d{1,2}월\s*고객\s*반응\s*\n?/, "").split("\n").map((line, i) => {
              const t = line.trim();
              if (!t) return <div key={i} style={{ height: 8 }} />;
              if (/^\d+\.\s/.test(t)) return <div key={i} style={{ fontSize: 18, fontWeight: 800, marginTop: i === 0 ? 0 : 18, marginBottom: 4, borderBottom: "1px solid var(--sm-border)", paddingBottom: 4 }}>{t}</div>;
              if (/^[가-힣]\.\s/.test(t)) return <div key={i} style={{ fontSize: 16, fontWeight: 700, marginTop: 10, marginBottom: 2 }}>{t}</div>;
              const m = t.match(/^-\s*([^:：]{1,16})\s*[:：]\s*(.*)$/);
              if (m) return <div key={i} style={{ whiteSpace: "pre-wrap", paddingLeft: line.startsWith("  ") ? 18 : 0 }}>- <strong>{m[1].trim()}</strong> : {m[2]}</div>;
              return <div key={i} style={{ whiteSpace: "pre-wrap", paddingLeft: line.startsWith("  ") ? 18 : 0 }}>{line.trimEnd()}</div>;
            })}
          </div>

          {/* 손해 청구 (제조사 귀책) — 개선요청서와 동일 기준. 제조사명을 넣었을 때만 */}
          {showClaim && (
            <div style={{ marginTop: 26 }}>
              <h3 style={{ fontSize: 18, fontWeight: 800, borderTop: "2px solid var(--sm-black)", paddingTop: 14 }}>3. 손해 청구 (제조사 귀책)</h3>
              {mfg.summary.count === 0 ? (
                <p style={{ fontSize: 15, marginTop: 8 }}>- 해당 없음</p>
              ) : (
                <>
                  <p style={{ fontSize: 15, marginTop: 8 }}>
                    {y}년 {Number(mm)}월 제조사 귀책 클레임은 총 <strong>{mfg.summary.count}건</strong>이며,
                    청구 손해액은 <strong style={{ color: "var(--sm-danger)" }}>{won(mfg.summary.claimable)}원</strong>입니다 (대상 제품 {mfg.summary.productCount}종).
                  </p>
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10 }}>
                    <thead><tr><th style={cellTh}>제품</th><th style={{ ...cellTh, ...num }}>건수</th><th style={cellTh}>주요 유형</th><th style={{ ...cellTh, ...num }}>청구 손해액(원)</th></tr></thead>
                    <tbody>
                      {mfg.byProduct.map((p) => (
                        <tr key={p.product}>
                          <td style={cellTd}>{p.product}</td>
                          <td style={{ ...cellTd, ...num }}>{p.count}</td>
                          <td style={cellTd}>{p.categories.map(([c, n]) => `${c} ${n}`).join(" · ")}</td>
                          <td style={{ ...cellTd, ...num }}>{won(p.claimable)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td style={{ ...cellTd, fontWeight: 800 }}>합계</td>
                        <td style={{ ...cellTd, ...num, fontWeight: 800 }}>{mfg.summary.count}</td>
                        <td style={cellTd}></td>
                        <td style={{ ...cellTd, ...num, fontWeight: 800 }}>{won(mfg.summary.claimable)}</td>
                      </tr>
                    </tbody>
                  </table>
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
                    <thead><tr><th style={cellTh}>접수일</th><th style={cellTh}>제품</th><th style={cellTh}>유형</th><th style={cellTh}>내용</th><th style={{ ...cellTh, ...num }}>손해(원)</th></tr></thead>
                    <tbody>
                      {mfg.items.map((r) => (
                        <tr key={r.id}>
                          <td style={{ ...cellTd, whiteSpace: "nowrap" }}>{(r.received_at || "").slice(5)}</td>
                          <td style={cellTd}>{r.product || "-"}</td>
                          <td style={{ ...cellTd, whiteSpace: "nowrap" }}>{r.category}</td>
                          <td style={cellTd}>{String(r.content || "")}</td>
                          <td style={{ ...cellTd, ...num }}>{won(r.loss_amount || 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </section>
      ) : (
        !loading && <div className="b2b-empty no-print">대상 월을 고르고 ‘AI 초안 생성’을 누르세요. 이전에 만든 달은 저장본이 자동으로 열립니다.</div>
      )}

      <p className="sm-faint no-print" style={{ fontSize: 12, marginTop: 12 }}>
        기간 단위 개선요청서는 <Link href="/voc/reports" className="sm-link">개선요청서</Link>, 전체 통계는 <Link href="/voc/stats" className="sm-link">통계·보고서</Link>에서.
      </p>
    </div>
  );
}
