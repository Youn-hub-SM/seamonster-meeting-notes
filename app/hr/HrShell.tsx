"use client";

// 급여·연차 창 전용 셸 — 업무도우미 셸(AppShell)은 /hr 아래에서 빠지고(AppShell 참조) 이 셸이 감싼다.
// 로그인부터 따로다: 쿠키 hr_auth, 로그인 화면 /hr/login. 업무도우미로 가는 링크·이름·로고를 두지 않는다.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Icon from "@/app/components/Icon";
import { FeedbackProvider } from "@/app/components/Feedback";
import "./hr.css";

const TITLE = "급여·연차";

const NAV = [
  { href: "/hr", label: "홈", icon: "home" as const, match: (p: string) => p === "/hr" },
  { href: "/hr/employees", label: "인사대장", icon: "user" as const, match: (p: string) => p.startsWith("/hr/employees") },
  { href: "/hr/work", label: "근무대장", icon: "note" as const, match: (p: string) => p.startsWith("/hr/work") },
  { href: "/hr/pay", label: "급여", icon: "receipt" as const, match: (p: string) => p.startsWith("/hr/pay") },
  { href: "/hr/tax", label: "원천세", icon: "tag" as const, match: (p: string) => p.startsWith("/hr/tax") },
  { href: "/hr/severance", label: "퇴직금", icon: "handshake" as const, match: (p: string) => p.startsWith("/hr/severance") },
  { href: "/hr/leave", label: "연차", icon: "ticket" as const, match: (p: string) => p.startsWith("/hr/leave") },
  { href: "/hr/docs", label: "증명서·계약서", icon: "pen" as const, match: (p: string) => p.startsWith("/hr/docs") },
  { href: "/hr/stats", label: "통계", icon: "trend" as const, match: (p: string) => p.startsWith("/hr/stats") },
  { href: "/hr/rates", label: "요율", icon: "bars" as const, match: (p: string) => p.startsWith("/hr/rates") },
  { href: "/hr/settings", label: "사업장", icon: "gear" as const, match: (p: string) => p.startsWith("/hr/settings") },
  { href: "/hr/guide", label: "사용 가이드", icon: "book" as const, match: (p: string) => p.startsWith("/hr/guide") },
];

export default function HrShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/hr";

  // 탭 제목 — 화면 이동 뒤 Next 가 루트 제목(업무도우미 이름)을 늦게 다시 넣는 경우가 있어, 바뀔 때마다 되돌린다
  //  (같으면 아무것도 하지 않아 무한 반복이 없다). 로그인 화면에서도 돈다.
  useEffect(() => {
    const apply = () => { if (document.title !== TITLE) document.title = TITLE; };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => mo.disconnect();
  }, [pathname]);

  // 로그인한 이름(로그아웃 옆에 보인다) — 쿠키는 화면에서 읽을 수 없어 서버에 한 번 묻는다. 못 받아도 화면은 그대로 돈다.
  const onLogin = pathname === "/hr/login";
  const [who, setWho] = useState("");
  useEffect(() => {
    if (onLogin) return;
    let alive = true;
    fetch("/api/hr/auth").then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j && typeof j.name === "string") setWho(j.name); }).catch(() => {});
    return () => { alive = false; };
  }, [onLogin]);

  if (onLogin) return <>{children}</>;

  async function logout() {
    await fetch("/api/hr/auth", { method: "DELETE" }).catch(() => {});
    window.location.href = "/hr/login";
  }

  return (
    <FeedbackProvider>
      <div className="hr-shell">
        <aside className="hr-sb">
          <Link href="/hr" className="hr-brand">파도소리 HR</Link>
          <nav className="hr-nav">
            {NAV.map((m) => (
              <Link key={m.href} href={m.href} prefetch={false} className={`hr-nav-item ${m.match(pathname) ? "is-active" : ""}`}>
                <Icon name={m.icon} />
                {m.label}
              </Link>
            ))}
          </nav>
          <div className="hr-sb-foot">
            {who && <span className="hr-sb-who" title={who}>{who}</span>}
            <button type="button" onClick={logout}>로그아웃</button>
          </div>
        </aside>
        <main className="hr-main">{children}</main>
      </div>
    </FeedbackProvider>
  );
}
