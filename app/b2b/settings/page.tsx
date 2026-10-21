"use client";

import { useCallback, useEffect, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/app/components/Feedback";
import type { SectionProps } from "./ui";
import OrdersSection from "./sections/Orders";
import ProductionSection from "./sections/Production";
import FulfillSection from "./sections/Fulfill";
import ReportsSection from "./sections/Reports";
import AiSection from "./sections/Ai";
import ConnectSection from "./sections/Connect";

// 관리자 › 설정 — 한 화면(2026-10-21 대표 결정). 왼쪽 = 업무 메뉴, 오른쪽 = 그 메뉴의 설정 카드.
//  옛 화면(AI 설정·Teams 연동·아사나 연동·Tally 연동·온라인 발주 설정·일반 설정)은 이 화면의 칸으로 옮겼다(옛 주소는 이리로 넘어온다).
//  모든 설정은 바꾼 뒤 아래 [저장]으로 반영 — 저장하지 않은 채 다른 칸으로 가거나 창을 닫으면 확인한다.
//  기획안 docs/admin-settings-plan.md. 파도소리 알림은 다시 설계하기로 해 이번엔 넣지 않았다.

type Key = "orders" | "production" | "fulfill" | "reports" | "ai" | "connect";
const SECTIONS: { key: Key; label: string; desc: string; C: ComponentType<SectionProps> }[] = [
  { key: "orders", label: "발주(B2B)", desc: "발주 알림 · 아침 일정 알림 · 거래명세표", C: OrdersSection },
  { key: "production", label: "생산·재고", desc: "생산·재고 알림 · 상품마스터 변경알림 · 주간 초안", C: ProductionSection },
  { key: "fulfill", label: "온라인 발주", desc: "중복 방지 · 박스 종류 · 택배 단가", C: FulfillSection },
  { key: "reports", label: "매출·리포트", desc: "종합 리포트 메일", C: ReportsSection },
  { key: "ai", label: "AI", desc: "데이터 비서 · 모델 · 프롬프트", C: AiSection },
  { key: "connect", label: "연결", desc: "Teams · 아사나 · Tally", C: ConnectSection },
];
const isKey = (s: string | null): s is Key => !!s && SECTIONS.some((x) => x.key === s);

export default function SettingsPage() {
  const router = useRouter();
  const confirm = useConfirm();
  const [sec, setSec] = useState<Key>("orders");
  const [dirty, setDirty] = useState(false);

  // 주소의 ?s= 로 칸을 연다(옛 화면 주소가 이리로 넘어올 때)
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("s");
    if (isKey(s)) setSec(s);
  }, []);

  // 저장하지 않은 변경이 있으면 창 닫기·새로고침을 확인
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const onDirty = useCallback((d: boolean) => setDirty(d), []);
  async function go(k: Key) {
    if (k === sec) return;
    if (dirty && !(await confirm({ title: "저장하지 않은 변경", body: "이 칸에서 바꾼 내용을 저장하지 않았습니다. 이동하면 바꾼 내용은 사라집니다.", action: "버리고 이동" }))) return;
    setDirty(false);
    setSec(k);
    router.replace(`/b2b/settings?s=${k}`, { scroll: false });
  }

  const cur = SECTIONS.find((x) => x.key === sec)!;
  const C = cur.C;
  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설정</h1>
          <p className="b2b-page-subtitle">바꾼 뒤 아래 [저장]을 눌러야 반영됩니다</p>
        </div>
      </header>
      <div className="set-layout">
        <nav className="set-nav" aria-label="설정 메뉴">
          {SECTIONS.map((x) => (
            <button key={x.key} type="button" className={`set-nav-item ${x.key === sec ? "is-active" : ""}`} aria-current={x.key === sec ? "page" : undefined} onClick={() => go(x.key)}>
              <span className="set-nav-label">{x.label}</span>
              <span className="set-nav-desc">{x.desc}</span>
            </button>
          ))}
        </nav>
        <div className="set-main">
          <C key={sec} onDirty={onDirty} />
        </div>
      </div>
    </div>
  );
}
