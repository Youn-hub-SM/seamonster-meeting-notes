"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type Tally = { key: string; sku: string; name: string; qty: number; unknown: boolean; zone?: string | null };
type State = { tally: Tally[]; scannedCount: number; totalInvoices: number; totalUnits: number };
type LastReset = { at: string; count: number } | null;
// 메시지 — dup = 이번 라운드에서 이미 찍음(무시), prev = 이전 라운드(초기화 전)에서 찍음(집계 제외, 넣기 가능),
//  moved = 이전 라운드 송장을 이번 라운드에 넣음, bad = 미등록·오류
type Msg = { kind: "ok" | "dup" | "prev" | "moved" | "bad"; text: string };
const MSG_COLOR: Record<Msg["kind"], { bg: string; fg: string }> = {
  ok: { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
  dup: { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },
  prev: { bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)" },
  moved: { bg: "var(--sm-info-bg)", fg: "var(--sm-info)" },
  bad: { bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)" },
};
const hm = (iso: string) => { try { return new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return iso; } };

// PC 알림 소리 — 스캐너 비프음은 스캐너가 스스로 내므로 바꿀 수 없다. 정상 스캔은 소리 없음(스캐너 소리만).
//  음성 = 브라우저 내장 한국어 음성(파일·비용 없음), 한국어 음성이 없는 PC 는 삐 소리로.
//  삐 소리: 이번 라운드 중복 = 짧게 두 번, 이전 라운드 = 높게 세 번, 미등록·오류 = 낮고 길게.
type SoundMode = "voice" | "beep" | "off";
type Alarm = "dup" | "prev" | "bad" | "err";
const BEEPS: Record<Alarm, [number, number][]> = {
  dup: [[660, 0.12], [0, 0.06], [660, 0.12]],
  prev: [[988, 0.14], [0, 0.06], [988, 0.14], [0, 0.06], [988, 0.22]],
  bad: [[220, 0.5]],
  err: [[220, 0.5]],
};
const VOICE: Record<Alarm, string> = { dup: "중복", prev: "이전 송장", bad: "미등록", err: "오류" };
const SOUND_KEY = "scan_sound"; // "voice" | "1"(삐 소리) | "0"(끔) — 없으면 음성

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

export default function ScanPage() {
  const [st, setSt] = useState<State | null>(null);
  const [error, setError] = useState("");
  const scanRef = useRef<HTMLInputElement>(null);
  const [scan, setScan] = useState("");
  const [pending, setPending] = useState(0); // 처리 대기 중인 스캔 수
  const [msg, setMsg] = useState<Msg | null>(null);
  const queueRef = useRef<string[]>([]);
  const processingRef = useRef(false);
  const [lastReset, setLastReset] = useState<LastReset>(null);
  // '이전 라운드 송장도 넣기' — 알면서 다시 찍어야 할 때 경고 없이 집계에 넣는다. 초기화하면 꺼진다(보호 복귀).
  const [includePrev, setIncludePrev] = useState(false);
  const includePrevRef = useRef(false);
  includePrevRef.current = includePrev;
  const [sound, setSound] = useState<SoundMode>("voice");
  const soundRef = useRef<SoundMode>("voice");
  soundRef.current = sound;
  // 한국어 음성 — null = 확인 중, false = 없음(삐 소리로 대신)
  const koVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const [koVoice, setKoVoice] = useState<boolean | null>(null);
  const lastPrevRef = useRef<string | null>(null); // F8 로 넣을 마지막 '이전 라운드' 송장
  const audioRef = useRef<AudioContext | null>(null);
  // 소리 장치는 첫 키 입력·클릭 때 깨워 둔다(브라우저는 사용자 동작 전엔 소리를 막는다 — 스캐너 입력도 키 입력)
  function audio(): AudioContext | null {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = audioRef.current ?? (audioRef.current = new AC());
      if (ctx.state === "suspended") void ctx.resume();
      return ctx;
    } catch { return null; }
  }
  useEffect(() => {
    try {
      const v = localStorage.getItem(SOUND_KEY);
      if (v === "0") setSound("off"); else if (v === "1") setSound("beep");
    } catch { /* 저장소 없음 */ }
    const wake = () => { if (soundRef.current !== "off") audio(); };
    window.addEventListener("keydown", wake, { once: true });
    window.addEventListener("pointerdown", wake, { once: true });
    return () => {
      window.removeEventListener("keydown", wake); window.removeEventListener("pointerdown", wake);
      void audioRef.current?.close().catch(() => {}); audioRef.current = null; // 화면 이동마다 소리 장치가 쌓이지 않게
    };
  }, []);
  useEffect(() => {
    const ss = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!ss) { setKoVoice(false); return; }
    const pick = () => {
      const all = ss.getVoices();
      if (!all.length) return; // 아직 로딩 중
      const ko = all.filter((v) => /^ko/i.test(v.lang));
      koVoiceRef.current = ko.find((v) => v.localService) ?? ko[0] ?? null;
      setKoVoice(!!koVoiceRef.current);
    };
    pick();
    ss.addEventListener("voiceschanged", pick);
    const t = setTimeout(() => setKoVoice((k) => (k === null ? false : k)), 2000); // 끝내 안 채워지면 없음
    return () => { ss.removeEventListener("voiceschanged", pick); clearTimeout(t); ss.cancel(); };
  }, []);
  // 음성으로 읽기 — 연달아 찍으면 앞 음성은 끊고 마지막 것만. 실패하면 삐 소리로.
  function speak(kind: Alarm): boolean {
    const ss = window.speechSynthesis, v = koVoiceRef.current;
    if (!ss || !v) return false;
    try {
      if (ss.speaking || ss.pending) ss.cancel();
      const u = new SpeechSynthesisUtterance(VOICE[kind]);
      u.voice = v; u.lang = v.lang; u.rate = 1.2;
      u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") beep(kind); };
      ss.speak(u);
      return true;
    } catch { return false; }
  }
  function alarm(kind: Alarm, mode: SoundMode = soundRef.current) {
    if (mode === "off") return;
    if (mode === "voice" && speak(kind)) return;
    beep(kind);
  }
  function beep(kind: Alarm) {
    try {
      const ctx = audio();
      if (!ctx) return;
      let t = ctx.currentTime;
      for (const [f, d] of BEEPS[kind]) {
        if (f) {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = "square"; o.frequency.value = f; g.gain.value = 0.12;
          o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + d);
        }
        t += d;
      }
    } catch { /* 소리 장치 없음 — 화면 메시지로 충분 */ }
  }

  const loadState = useCallback(async (silent = false) => {
    if (!silent) setError("");
    try {
      const j = await (await fetch("/api/fulfill/scan/state", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setSt({ tally: j.tally, scannedCount: j.scannedCount, totalInvoices: j.totalInvoices, totalUnits: j.totalUnits });
      setLastReset(j.lastReset ?? null);
    } catch (e) { if (!silent) setError(e instanceof Error ? e.message : "조회 실패"); }
  }, []);

  useEffect(() => {
    loadState();
    setTimeout(() => scanRef.current?.focus(), 100);
    // 업로더가 추가한 데이터 반영. 단, 스캔 처리 중엔 건너뜀(진행 중 집계 덮어쓰기 방지).
    //  유휴 상태에서만 도는 조회라 30초면 충분하다(8초는 서버 실행 시간만 4배로 쓴다).
    //  스캔을 찍는 동안에는 각 처리가 끝날 때 집계가 갱신되므로 이 주기와 무관하다.
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return; // 백그라운드 탭은 조회하지 않음
      if (!processingRef.current && queueRef.current.length === 0) loadState(true);
    }, 30000);
    return () => clearInterval(t);
  }, [loadState]);

  // 입력은 즉시 비우고 다음 스캔을 받음. 실제 처리(서버 왕복)는 백그라운드 큐에서 순차 진행 → 스캔이 안 밀림.
  function submitScan() {
    const inv = scan.trim();
    if (!inv) return;
    setScan("");
    queueRef.current.push(inv);
    setPending(queueRef.current.length);
    scanRef.current?.focus();
    pump();
  }
  async function pump() {
    if (processingRef.current) return;
    processingRef.current = true;
    while (queueRef.current.length) {
      const q = queueRef.current;
      const inv = q[0];
      try {
        await sendScan(inv, includePrevRef.current);
      } catch (e) { setMsg({ kind: "bad", text: e instanceof Error ? e.message : "스캔 실패" }); alarm("err"); }
      q.shift(); // 처리 중 초기화로 큐가 바뀌었으면 옛 큐에서만 뺀다(새 라운드 첫 스캔이 사라지지 않게)
      setPending(queueRef.current.length);
    }
    processingRef.current = false;
  }

  // 스캔 1건 처리 — include=true 면 이전 라운드 송장을 이번 라운드에 넣는다
  async function sendScan(inv: string, include: boolean) {
    lastPrevRef.current = null; // F8 은 화면에 떠 있는 빨간 경고의 송장에만(다음 스캔·오류가 오면 대상 아님)
    const j = await (await fetch("/api/fulfill/scan/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice_no: inv, include_prev: include }) })).json();
    if (!j.ok) throw new Error(j.error || "스캔 실패");
    if (!j.known) { setMsg({ kind: "bad", text: `미등록 송장번호 · ${inv}` }); alarm("bad"); return; }
    setSt((s) => ({ tally: j.tally, scannedCount: j.scannedCount, totalUnits: j.totalUnits, totalInvoices: s?.totalInvoices ?? 0 }));
    if (j.moved) { setMsg({ kind: "moved", text: `이전 라운드 송장 · 이번 라운드에 넣음 · ${inv}` }); return; }
    if (j.prevRound) {
      lastPrevRef.current = inv;
      setMsg({ kind: "prev", text: `이전 라운드에서 스캔한 송장 · ${inv} · ${hm(j.prevRound.scanned_at)}${j.prevRound.scanned_by ? ` · ${j.prevRound.scanned_by}` : ""} — 집계 제외` });
      alarm("prev");
      return;
    }
    if (j.alreadyScanned) { setMsg({ kind: "dup", text: `이미 스캔한 송장 · ${inv}` }); alarm("dup"); return; }
    setMsg({ kind: "ok", text: `스캔 완료 · ${inv}` });
  }
  // 경고 줄의 [이번 라운드에 넣기]·F8 — 마지막 '이전 라운드' 송장 1건을 넣는다
  async function includeLast() {
    const inv = lastPrevRef.current;
    if (!inv) return; // 두 번 눌러도 한 번만(보내기 전에 비워진다)
    scanRef.current?.focus();
    try { await sendScan(inv, true); } catch (e) { setMsg({ kind: "bad", text: e instanceof Error ? e.message : "넣기 실패" }); alarm("err"); }
  }

  // 스캔 초기화 — 인쇄 후 다음 라운드를 위해 자주 누르므로 확인창 없이 즉시(업로드 데이터는 유지).
  //  기록은 30일 보관(이전 라운드 송장 재스캔을 잡는다). '이전 라운드 송장도 넣기'는 꺼진다.
  async function reset() {
    queueRef.current = []; setPending(0); // 대기 중 스캔도 취소(깨끗한 새 라운드)
    includePrevRef.current = false; setIncludePrev(false); lastPrevRef.current = null; // 응답 전 스캔부터 다시 보호
    try {
      const j = await (await fetch("/api/fulfill/scan/reset", { method: "POST" })).json();
      if (!j.ok) throw new Error(j.error || "초기화 실패");
      setSt({ tally: j.tally, scannedCount: j.scannedCount, totalInvoices: j.totalInvoices, totalUnits: j.totalUnits });
      setLastReset(j.lastReset ?? null);
      setMsg({ kind: "ok", text: "초기화 완료 · 새로 스캔하세요" });
      scanRef.current?.focus();
    } catch (e) { setError(e instanceof Error ? e.message : "초기화 실패"); }
  }
  // 직전 초기화 되돌리기 — 실수로 초기화했을 때 다시 찍지 않고 그 라운드를 되살린다(이번 라운드에 찍은 것과 합쳐진다)
  const undoingRef = useRef(false);
  async function undoReset() {
    if (!lastReset || undoingRef.current) return;
    const ok = window.confirm(`${hm(lastReset.at)}에 초기화한 ${lastReset.count.toLocaleString()}건을 이번 라운드로 되돌릴까요?`);
    scanRef.current?.focus(); // 버튼에 포커스가 남으면 다음 스캔의 Enter 가 버튼을 또 누른다
    if (!ok) return;
    undoingRef.current = true;
    try {
      const j = await (await fetch("/api/fulfill/scan/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ undo: true, at: lastReset.at }) })).json();
      if (!j.ok) throw new Error(j.error || "되돌리기 실패");
      setSt({ tally: j.tally, scannedCount: j.scannedCount, totalInvoices: j.totalInvoices, totalUnits: j.totalUnits });
      setLastReset(j.lastReset ?? null);
      setMsg({ kind: "ok", text: `초기화 되돌림 · ${Number(j.restored || 0).toLocaleString()}건` });
    } catch (e) { setError(e instanceof Error ? e.message : "되돌리기 실패"); void loadState(true); }
    finally { undoingRef.current = false; }
  }

  // 피킹 리스트 인쇄 — 품목명·수량. 창고 위치(구역)가 설정돼 있으면 구역 소제목으로 묶어 걷는 순서대로.
  function printTally() {
    if (!st || !st.tally.length) return;
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const grouped = st.tally.some((t) => t.zone); // 구역 미설정이면 소제목 없이 기존 형태 그대로
    let rows = "";
    let curZone: string | undefined;
    for (const t of st.tally) {
      if (grouped) {
        const z = t.unknown ? "미등록 코드" : t.zone || "위치 미지정";
        if (z !== curZone) { curZone = z; rows += `<tr class="z"><td colspan="2">${esc(z)}</td></tr>`; }
      }
      rows += `<tr><td>${esc(t.name)}</td><td class="q">${t.qty.toLocaleString()}</td></tr>`;
    }
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>피킹 리스트</title>`
      + `<style>*{box-sizing:border-box}body{font-family:system-ui,-apple-system,'Malgun Gothic',sans-serif;margin:22px;color:#111}`
      + `h1{font-size:19px;margin:0 0 3px}.meta{color:#666;font-size:12px;margin-bottom:14px}`
      + `table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #d0d0d0;padding:10px 6px;text-align:left}`
      + `th{font-size:12px;color:#666}td{font-size:17px}th.q,td.q{text-align:right;width:90px}td.q{font-weight:800;font-size:21px}`
      + `tr.z td{background:#ececec;font-weight:800;font-size:13px;padding:6px;border-bottom:1px solid #aaa;letter-spacing:.5px}`
      + `tfoot td{font-weight:800;border-top:2px solid #333;border-bottom:none;font-size:17px}`
      + `@media print{body{margin:6mm}}</style></head><body>`
      + `<h1>피킹 리스트</h1>`
      + `<div class="meta">출력 ${ts} · 스캔 ${st.scannedCount}건</div>`
      + `<table><thead><tr><th>품목명</th><th class="q">수량</th></tr></thead><tbody>${rows}</tbody>`
      + `<tfoot><tr><td>합계</td><td class="q">${st.totalUnits.toLocaleString()}</td></tr></tfoot></table>`
      + `<script>window.onload=function(){setTimeout(function(){window.print()},80)}</script></body></html>`;
    const w = window.open("", "_blank", "width=560,height=880");
    if (!w) { alert("팝업이 차단되었습니다. 팝업을 허용한 뒤 다시 인쇄하세요."); return; }
    w.document.write(html);
    w.document.close();
  }

  // 단축키: F2=인쇄, F4=초기화, F8=이전 라운드 송장 넣기. 바코드 스캐너는 F키를 보내지 않아 스캔 입력과 충돌하지 않음.
  const actRef = useRef<{ print: () => void; reset: () => void; include: () => void }>({ print: () => {}, reset: () => {}, include: () => {} });
  actRef.current = { print: printTally, reset, include: includeLast };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") { e.preventDefault(); actRef.current.print(); }
      else if (e.key === "F4") { e.preventDefault(); actRef.current.reset(); }
      else if (e.key === "F8") { e.preventDefault(); actRef.current.include(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="b2b-container" style={{ maxWidth: 760 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">송장 스캔</h1>
        </div>
        <div className="b2b-page-actions" style={{ display: "flex", gap: 8 }}>
          <Link className="b2b-btn-secondary" href="/fulfill/locations">창고 위치</Link>
          <Link className="b2b-btn-secondary" href="/fulfill/scan/upload">송장 업로드</Link>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{error.includes("057") ? " — supabase/migrations/057_fulfill_scan.sql 를 먼저 적용하세요." : ""}</div>}

      {st && st.totalInvoices === 0 && !error && (
        <div className="b2b-empty" style={{ marginBottom: 16 }}>스캔할 송장 데이터가 없습니다.</div>
      )}

      <section className="b2b-card" style={{ marginBottom: 14 }}>
        <div className="sm-between" style={{ alignItems: "baseline" }}>
          <label className="b2b-field-label">송장번호 스캔 <span className="sm-faint" style={{ fontWeight: 400 }}>(하이픈 있어도/없어도 인식)</span></label>
          <span className="sm-faint" style={{ fontSize: 12 }}>
            이번 스캔 <strong style={{ color: "var(--sm-success)", fontSize: 15 }}>{st?.scannedCount ?? 0}</strong>건 · 대상 {st?.totalInvoices ?? 0}건
            {pending > 0 && <span style={{ color: "var(--sm-info)", marginLeft: 6 }}>· 처리 중 {pending}</span>}
          </span>
        </div>
        <input
          ref={scanRef}
          className="b2b-input"
          value={scan}
          onChange={(e) => setScan(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitScan(); } }}
          placeholder="바코드를 스캔하거나 송장번호 입력 후 Enter"
          autoFocus
          style={{ fontSize: 20, padding: "12px 14px", fontWeight: 700, letterSpacing: 0.5 }}
        />
        {msg && (
          <div className="sm-row" style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, fontSize: 15, fontWeight: 700, gap: 10, flexWrap: "wrap", alignItems: "center",
            background: MSG_COLOR[msg.kind].bg, color: MSG_COLOR[msg.kind].fg }}>
            <span style={{ flex: "1 1 240px" }}>{msg.kind === "ok" ? "✓ " : msg.kind === "dup" ? "· " : ""}{msg.text}</span>
            {msg.kind === "prev" && (
              <button type="button" className="b2b-btn-secondary" onMouseDown={(e) => e.preventDefault()} onClick={includeLast} style={{ padding: "6px 12px", fontSize: 15 }}>이번 라운드에 넣기 (F8)</button>
            )}
          </div>
        )}
        <div className="sm-row" style={{ marginTop: 10, gap: 16, flexWrap: "wrap", fontSize: 15 }}>
          <label className="sm-row" style={{ gap: 6 }}>
            소리
            <select className="b2b-select" value={sound} style={{ width: "auto", padding: "4px 8px" }}
              onChange={(e) => {
                const m = e.target.value as SoundMode;
                setSound(m);
                try { localStorage.setItem(SOUND_KEY, m === "voice" ? "voice" : m === "beep" ? "1" : "0"); } catch { /* 저장소 없음 */ }
                alarm("dup", m); // 미리 듣기
                scanRef.current?.focus();
              }}>
              <option value="voice">음성</option>
              <option value="beep">삐 소리</option>
              <option value="off">끔</option>
            </select>
            {sound === "voice" && koVoice === false && <span className="sm-faint" style={{ fontSize: 12 }}>이 PC에 한국어 음성이 없어 삐 소리로 알립니다</span>}
          </label>
          <label className="sm-row" style={{ gap: 6, cursor: "pointer", color: includePrev ? "var(--sm-info)" : undefined, fontWeight: includePrev ? 700 : undefined }}>
            <input type="checkbox" className="b2b-checkbox" checked={includePrev} onChange={(e) => { setIncludePrev(e.target.checked); scanRef.current?.focus(); }} />
            이전 라운드 송장도 넣기{includePrev ? " (켜짐 — 초기화하면 꺼짐)" : ""}
          </label>
        </div>
      </section>

      {/* 인쇄 → 상품 가지러 → 초기화 → 다음 스캔. 두 버튼을 크고 눈에 띄게. */}
      <div className="sm-row" style={{ gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <button className="b2b-btn-primary" onClick={printTally} disabled={!st || st.tally.length === 0}
          style={{ flex: "1 1 200px", padding: "16px", fontSize: 17, fontWeight: 800 }}>인쇄 <span style={{ opacity: 0.8, fontWeight: 600 }}>(F2)</span></button>
        <button onClick={reset} disabled={!st || st.scannedCount === 0}
          style={{ flex: "1 1 200px", padding: "16px", fontSize: 17, fontWeight: 800, cursor: "pointer",
            background: "var(--sm-warning-bg)", color: "var(--sm-warning)", border: "2px solid var(--sm-warning)", borderRadius: 10,
            opacity: !st || st.scannedCount === 0 ? 0.5 : 1 }}>↺ 초기화 <span style={{ opacity: 0.8, fontWeight: 600 }}>(F4)</span></button>
      </div>
      {lastReset && lastReset.count > 0 && (
        <div className="sm-row" style={{ gap: 10, marginTop: -6, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" className="b2b-link-btn" onClick={undoReset}>직전 초기화 되돌리기</button>
          <span className="sm-faint" style={{ fontSize: 12 }}>{hm(lastReset.at)} · {lastReset.count.toLocaleString()}건 · 스캔 기록 30일 보관</span>
        </div>
      )}

      <section className="b2b-card">
        <div className="b2b-card-head">
          <span className="b2b-card-title">가지러 갈 상품 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 총 {st?.totalUnits.toLocaleString() ?? 0}개 · 묶음 전개 반영</span></span>
        </div>
        {!st || st.tally.length === 0 ? (
          <div className="b2b-empty" style={{ padding: 24 }}>아직 스캔된 송장이 없습니다.</div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr>{st.tally.some((t) => t.zone) && <th>위치</th>}<th>품목명</th><th>SKU</th><th className="num">수량</th></tr></thead>
              <tbody>
                {st.tally.map((t) => (
                  <tr key={t.key} style={{ background: t.unknown ? "var(--sm-danger-bg)" : undefined }}>
                    {st.tally.some((x) => x.zone) && (
                      <td style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{t.unknown ? "-" : t.zone || <span className="sm-faint" style={{ fontWeight: 400 }}>미지정</span>}</td>
                    )}
                    <td><strong>{t.name}</strong></td>
                    <td className="sm-faint">{t.sku || "-"}</td>
                    <td className="num b2b-money" style={{ fontWeight: 800, fontSize: 15 }}>{t.qty.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {st && st.tally.some((t) => t.unknown) && <p className="sm-faint" style={{ fontSize: 12, marginTop: 8, color: "var(--sm-danger)" }}>빨간 줄 = <Link href="/b2b/products">상품마스터</Link>에 없는 단품코드</p>}
      </section>
    </div>
  );
}
