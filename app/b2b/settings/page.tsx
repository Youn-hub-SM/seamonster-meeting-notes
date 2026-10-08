"use client";

import { useEffect, useState } from "react";
import { scheduleHorizon, kstTodayIso, type ScheduleHorizon } from "@/app/lib/production-schedule";

// 설정 · 기타 — 거래명세표 공급자 정보 + 권장생산 목표 기간(생산 일정 기반, 읽기 전용) + 발송완료 매출 반영 안내.
//  2026-08-24 설정 재구성: 알림 카드들은 'Teams 연동'(/b2b/settings/teams)으로 이동.
type Msg = { ok: boolean; text: string };

export default function SettingsEtcPage() {
  // 거래명세표 — 공급자(우리 회사) 정보 + 직인
  type Supplier = { name: string; biz_no: string; ceo: string; addr: string; biz_type: string; biz_item: string; email: string; bank: string; manager: string; phone: string };
  const [sup, setSup] = useState<Supplier>({ name: "", biz_no: "", ceo: "", addr: "", biz_type: "", biz_item: "", email: "youn@seamonster.kr", bank: "", manager: "", phone: "" });
  const [stamp, setStamp] = useState("");
  const [supSaving, setSupSaving] = useState(false);
  const [supMsg, setSupMsg] = useState<Msg | null>(null);
  const [error, setError] = useState("");

  // 권장생산 목표 기간 — 예전 '리드타임 · 발주 주기' 입력은 없앴다. 생산 일정(D+8 판매 가능·매주 수요일 요청)에서
  //  날짜로 계산된다(2026-09-28). 화면을 연 날(KST) 기준 — 빌드 시점 날짜로 미리 그려지지 않게 마운트 후 계산한다.
  const [sched, setSched] = useState<ScheduleHorizon | null>(null);

  useEffect(() => {
    setSched(scheduleHorizon(kstTodayIso()));
    (async () => {
      try {
        const st = await (await fetch("/api/b2b/settings/statement", { cache: "no-store" })).json();
        if (st.ok) { setSup(st.supplier); setStamp(st.stamp || ""); }
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
          <h2 className="b2b-card-title">거래명세표</h2>
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
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>세금계산서 담당자</span>
            <input className="b2b-input" value={sup.manager ?? ""} onChange={(e) => setSup({ ...sup, manager: e.target.value })} /></label>
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>담당자 연락처</span>
            <input className="b2b-input" value={sup.phone ?? ""} onChange={(e) => setSup({ ...sup, phone: e.target.value })} placeholder="010-0000-0000" /></label>
          <label className="sm-col" style={{ gap: 3, gridColumn: "1 / -1" }}><span style={{ fontSize: 13, fontWeight: 600 }}>입금 은행정보</span>
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
            <span className="sm-faint" style={{ fontSize: 12 }}>투명 배경 PNG · 500KB 이하</span>
          )}
        </div>
      </section>

      {/* 권장생산 목표 기간 — 생산 일정에서 계산(읽기 전용) */}
      <section className="b2b-card" style={{ marginTop: 28 }}>
        <div className="b2b-card-head"><h2 className="b2b-card-title">권장생산 목표 기간</h2></div>
        <p style={{ fontSize: 12, color: "var(--sm-text-mid)", margin: "0 0 10px", lineHeight: 1.6 }}>
          생산 일정(영업일): 작성 D → 컨펌 D+1 → 생산 시작 D+3 → 생산 마감 D+7 → 판매 가능 D+8
        </p>
        {sched && <ul style={{ fontSize: 13, margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
          <li><strong>목표</strong> = 평상시 하루 출고 × <strong>{sched.horizonDays}일</strong> (오늘 → 다음 요청일 {sched.nextDraft.slice(5)} 요청분 판매 가능일 {sched.nextSellable.slice(5)})</li>
          <li><strong>부족</strong> = 현재고 + 입고 예정이 하루 출고 × <strong>{sched.leadDays}일</strong> (오늘 → 오늘 요청분 판매 가능일 {sched.sellable.slice(5)}) 미만</li>
          <li><strong>권장생산</strong> = 소매 모자란 양 + 도매 모자란 양 − 입고 예정 (모자란 양 = 목표 − 현재고, 0 미만은 0)</li>
        </ul>}
      </section>

      {/* 발주 완료 → 매출 데이터(Supabase) 자동 반영 */}
      <section className="b2b-card" style={{ marginTop: 28 }}>
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">발송완료 매출 반영</h2>
          <span style={{ fontSize: 11.5, color: "var(--sm-success)" }}>● 자동</span>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--sm-text-mid)", margin: 0, lineHeight: 1.8 }}>
          발송완료되면 매출 데이터에 반영 · 채널 &lsquo;도매&rsquo; · 발주별 1회 · 고객 집계 제외
        </p>
      </section>
    </>
  );
}
