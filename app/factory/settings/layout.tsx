"use client";

// 파도소리 설정(관리자 전용) — 품목 마스터 · 알림 탭. 제목·탭은 여기서 한 번만 그리고,
//  각 탭 화면의 자체 제목(.b2b-page-head)은 factory.css(.fac-set-body)에서 숨긴다.
//  권한은 API 가 따로 검사한다(품목 등록·알림 설정 = 관리자). 여기서는 파도소리 계정에 화면만 막는다.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/factory/settings/products", label: "품목" },
  { href: "/factory/settings", label: "알림", exact: true },
];

export default function FactorySettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "";
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/b2b/auth", { cache: "no-store" }).then((r) => r.json())
      .then((j) => setRole(j?.ok ? j.role || "internal" : "factory"))
      .catch(() => setRole("factory"));
  }, []);

  return (
    <div className="b2b-container fac-set">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">설정</h1></div>
      </header>
      <div className="sm-tabs fac-set-tabs">
        {TABS.map((t) => {
          const on = t.exact ? pathname === t.href : pathname.startsWith(t.href);
          return <Link key={t.href} href={t.href} className={`sm-tab ${on ? "is-active" : ""}`}>{t.label}</Link>;
        })}
      </div>
      {role === null ? <div className="b2b-loading">불러오는 중...</div>
        : role === "factory" ? <div className="b2b-empty">관리자 전용 화면입니다.</div>
        : <div className="fac-set-body">{children}</div>}
    </div>
  );
}
