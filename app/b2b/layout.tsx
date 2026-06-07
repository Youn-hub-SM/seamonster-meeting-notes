import Link from "next/link";
import "./b2b.css";

export const metadata = {
  title: "B2B 관리툴 · 씨몬스터",
};

export default function B2BLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="b2b-shell">
      <nav className="b2b-subnav">
        <div className="b2b-subnav-inner">
          <Link href="/b2b" className="b2b-subnav-link">대시보드</Link>
          <Link href="/b2b/orders" className="b2b-subnav-link">발주</Link>
          <Link href="/b2b/companies" className="b2b-subnav-link">업체 주소록</Link>
          <Link href="/b2b/products" className="b2b-subnav-link">원가표</Link>
          <Link href="/b2b/reports" className="b2b-subnav-link">매출 집계</Link>
          <Link href="/b2b/payments" className="b2b-subnav-link">입금 확인</Link>
        </div>
      </nav>
      <main className="b2b-main">{children}</main>
    </div>
  );
}
