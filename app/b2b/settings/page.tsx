"use client";

import { useEffect, useState } from "react";

// 설정 · 기타 — 거래명세표 공급자 정보 + 생산 리드타임 + 발송완료 매출 반영 안내.
//  2026-08-24 설정 재구성: 알림 카드들은 'Teams 연동'(/b2b/settings/teams)으로 이동.
type Msg = { ok: boolean; text: string };

export default function SettingsEtcPage() {
  // 거래명세표 — 공급자(우리 회사) 정보 + 직인
  type Supplier = { name: string; biz_no: string; ceo: string; addr: string; biz_type: string; biz_item: string; email: string; bank: string };
  const [sup, setSup] = useState<Supplier>({ name: "", biz_no: "", ceo: "", addr: "", biz_type: "", biz_item: "", email: "youn@seamonster.kr", bank: "" });
  const [stamp, setStamp] = useState("");
  const [supSaving, setSupSaving] = useState(false);
  const [supMsg, setSupMsg] = useState<Msg | null>(null);
  const [error, setError] = useState("");

  // 생산 리드타임 (구 생산관리 설정에서 이관)
  const [leadInput, setLeadInput] = useState("");
  const [leadSaved, setLeadSaved] = useState<number | null>(null);
  const [leadSaving, setLeadSaving] = useState(false);
  const [leadMsg, setLeadMsg] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const st = await (await fetch("/api/b2b/settings/statement", { cache: "no-store" })).json();
        if (st.ok) { setSup(st.supplier); setStamp(st.stamp || ""); }
        const ld = await (await fetch("/api/production/lead-days", { cache: "no-store" })).json();
        if (ld.ok) { setLeadSaved(ld.leadDays); setLeadInput(String(ld.leadDays)); }
      } catch (e) {
        setError(e instanceof Error ? e.message : "조회 중 오류");
      }
    })();
  }, []);

  async function saveSupplier() {
    setSupSaving(true); setSupMsg(null);
    try {
      const r = await fetch("/api/b2b/settings/statement", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ supplier: sup, stamp }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setSupMsg({ ok: true, text: "저장됨" });
    } catch (e) { setSupMsg({ ok: false, text: e instanceof Error ? e.message : "저장 오류" }); }
    setSupSaving(false);
  }
  function onStampFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 500_000) { setSupMsg({ ok: false, text: "직인 이미지는 500KB 이하 PNG 로 올려주세요." }); return; }
    const reader = new FileReader();
    reader.onload = () => setStamp(String(reader.result || ""));
    reader.readAsDataURL(f);
  }

  async function saveLead() {
    const n = Math.round(Number(leadInput));
    if (!Number.isFinite(n) || n < 1 || n > 60) { setLeadMsg("1~60 사이 숫자를 입력하세요."); return; }
    setLeadSaving(true);
    setLeadMsg("");
    try {
      const res = await fetch("/api/production/lead-days", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: n }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setLeadSaved(j.leadDays);
      setLeadInput(String(j.leadDays));
      setLeadMsg(`저장됨 — 안전재고가 하루 출고 × ${j.leadDays}일로 계산됩니다.`);
    } catch (e) {
      setLeadMsg(e instanceof Error ? e.message : "저장 실패");
    }
    setLeadSaving(false);
  }

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설정 · 기타</h1>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {/* 거래명세표 — 공급자 정보 + 직인 */}
      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">거래명세표 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 공급자(우리 회사) 정보 · 발주 목록의 &lsquo;명세표&rsquo;에서 사용</span></h2>
          <button className="b2b-btn-primary" onClick={saveSupplier} disabled={supSaving}>{supSaving ? "저장 중..." : "저장"}</button>
        </div>
        {supMsg && <div className={supMsg.ok ? "sm-success" : "b2b-error"} style={{ marginBottom: 10 }}>{supMsg.text}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>상호</span>
            <input className="b2b-input" value={sup.name} onChange={(e) => setSup({ ...sup, name: e.target.value })} placeholder="예: 씨몬스터" /></label>
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>사업자등록번호</span>
            <input className="b2b-input" value={sup.biz_no} onChange={(e) => setSup({ ...sup, biz_no: e.target.value })} placeholder="000-00-00000" /></label>
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>대표자</span>
            <input className="b2b-input" value={sup.ceo} onChange={(e) => setSup({ ...sup, ceo: e.target.value })} /></label>
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>이메일</span>
            <input className="b2b-input" value={sup.email} onChange={(e) => setSup({ ...sup, email: e.target.value })} placeholder="youn@seamonster.kr" /></label>
          <label className="sm-col" style={{ gap: 3, gridColumn: "1 / -1" }}><span style={{ fontSize: 13, fontWeight: 600 }}>사업장 소재지</span>
            <input className="b2b-input" value={sup.addr} onChange={(e) => setSup({ ...sup, addr: e.target.value })} /></label>
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>업태</span>
            <input className="b2b-input" value={sup.biz_type} onChange={(e) => setSup({ ...sup, biz_type: e.target.value })} placeholder="예: 도소매" /></label>
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>종목</span>
            <input className="b2b-input" value={sup.biz_item} onChange={(e) => setSup({ ...sup, biz_item: e.target.value })} placeholder="예: 수산물" /></label>
          <label className="sm-col" style={{ gap: 3, gridColumn: "1 / -1" }}><span style={{ fontSize: 13, fontWeight: 600 }}>입금 은행정보 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 12 }}>· 명세표 하단에 표시</span></span>
            <input className="b2b-input" value={sup.bank} onChange={(e) => setSup({ ...sup, bank: e.target.value })} placeholder="예: 국민은행 000000-00-000000 (예금주: 씨몬스터)" /></label>
        </div>
        <div className="sm-row" style={{ gap: 12, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>직인(도장) 이미지</span>
          <input type="file" accept="image/png,image/jpeg" onChange={onStampFile} style={{ fontSize: 12 }} />
          {stamp ? (
            <>
              <img src={stamp} alt="직인 미리보기" style={{ width: 44, height: 44, objectFit: "contain", border: "1px solid var(--sm-border)", borderRadius: 6, background: "var(--sm-white)" }} />
              <button className="b2b-link-btn" style={{ color: "var(--sm-danger)" }} onClick={() => setStamp("")}>직인 제거</button>
            </>
          ) : (
            <span className="sm-faint" style={{ fontSize: 12 }}>배경이 투명한 PNG(500KB 이하)를 올리면 명세표 공급자란에 자동으로 찍힙니다.</span>
          )}
        </div>
      </section>

      {/* 생산 리드타임 (구 생산관리 설정에서 이관) */}
      <section className="b2b-card" style={{ marginTop: 28 }}>
        <div className="b2b-card-head"><h2 className="b2b-card-title">생산 리드타임</h2></div>
        <p style={{ fontSize: 12, color: "var(--sm-text-mid)", margin: "0 0 14px", lineHeight: 1.6 }}>
          제조사에 생산을 요청하고 받기까지 걸리는 일수입니다. <strong>안전재고 = 하루 평균 출고 × 리드타임</strong>으로,
          이 기간 팔릴 만큼은 늘 확보해 재고 쇼트를 막습니다. {leadSaved != null && <>현재 <strong>{leadSaved}일</strong>.</>}
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            className="b2b-input"
            type="number"
            min={1}
            max={60}
            value={leadInput}
            onChange={(e) => setLeadInput(e.target.value)}
            style={{ width: 120 }}
          />
          <span style={{ fontSize: 15, color: "var(--sm-text-mid)" }}>일</span>
          <button className="b2b-btn-primary" onClick={saveLead} disabled={leadSaving}>
            {leadSaving ? "저장 중..." : "저장"}
          </button>
        </div>
        {leadMsg && (
          <div style={{ marginTop: 10, fontSize: 12, color: leadMsg.startsWith("저장됨") ? "var(--sm-success)" : "var(--sm-danger)", fontWeight: 600 }}>
            {leadMsg}
          </div>
        )}
      </section>

      {/* 발주 완료 → 매출 데이터(Supabase) 자동 반영 */}
      <section className="b2b-card" style={{ marginTop: 28 }}>
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">발송완료 매출 반영</h2>
          <span style={{ fontSize: 11.5, color: "var(--sm-success)" }}>● 자동</span>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--sm-text-mid)", margin: 0, lineHeight: 1.8 }}>
          발주가 <strong>발송완료</strong>되면 라인아이템별 매출이 <strong>매출 데이터</strong>에 자동 반영됩니다
          (채널 <strong>&lsquo;도매&rsquo;</strong>, 발주별 1회, 중복 방지). <a href="/sales/report" style={{ color: "var(--sm-orange)", fontWeight: 600 }}>매출 리포트</a>·
          <a href="/sales/search" style={{ color: "var(--sm-orange)", fontWeight: 600 }}> 주문 검색</a>에서 함께 조회됩니다.
          <br />
          별도 설정이 필요 없으며, 기존 <strong>구글시트 연동은 종료</strong>되었습니다. 재구매·고객 분석 오염을 막기 위해 도매 매출은 매출액만 반영하고 개별 고객으로는 집계하지 않습니다.
        </p>
      </section>
    </>
  );
}
