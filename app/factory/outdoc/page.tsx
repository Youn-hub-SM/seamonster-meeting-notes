"use client";

// 파도소리 출고증 — 출고 한 건(?batch=입력 번호)을 실물 양식대로 그려 인쇄한다(2026-11-20 대표가 준 실물 사진 기준).
//  받는 곳이 보관처라 보관처마다 따로, 한 장에 12줄 — 넘으면 다음 장. 번호는 서버가 처음 열 때 매기고 다시 열어도 같다.
//  회사 정보(상호·대표·전화·팩스·로고·직인)는 [거래처] 화면의 [회사 정보]에서 관리자가 넣는다.

import { useEffect, useState } from "react";
import { OUT_DOC_ROWS, type OutDoc, type OutDocLine } from "@/app/lib/factory-partners";

const DAYS = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
const longDate = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  return `${t.getUTCFullYear()}년 ${t.getUTCMonth() + 1}월 ${t.getUTCDate()}일 ${DAYS[t.getUTCDay()]}`;
};
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);
// 발행일자 — 번호를 처음 낸 시각(KST)
const issued = (iso: string) => {
  const k = new Date(Date.parse(iso) + 9 * 3600e3);
  const h = k.getUTCHours();
  return `${k.toISOString().slice(0, 10)} ${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}:${String(k.getUTCMinutes()).padStart(2, "0")}`;
};
const qty = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });

export default function FactoryOutDocPage() {
  const [doc, setDoc] = useState<OutDoc | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const batch = new URLSearchParams(window.location.search).get("batch") || "";
    (async () => {
      try {
        const j = await (await fetch(`/api/factory/outdoc?batch=${encodeURIComponent(batch)}`, { cache: "no-store" })).json();
        if (!j.ok) throw new Error(j.error || "출고증을 불러오지 못했습니다.");
        setDoc(j.doc);
      } catch (e) { setError(e instanceof Error ? e.message : "출고증을 불러오지 못했습니다."); }
    })();
  }, []);

  if (error) return <div className="b2b-container"><div className="b2b-error">{error}</div></div>;
  if (!doc) return <div className="b2b-container"><div className="b2b-loading">불러오는 중...</div></div>;

  // 보관처마다, 12줄마다 한 장
  const pages: { storage: string; lines: OutDocLine[]; total: number | null }[] = [];
  for (const s of doc.sheets) {
    for (let at = 0; at < s.lines.length; at += OUT_DOC_ROWS) {
      const lines = s.lines.slice(at, at + OUT_DOC_ROWS);
      const last = at + OUT_DOC_ROWS >= s.lines.length;
      // 합계는 그 보관처의 마지막 장에만(단위가 섞여 있으면 수량을 더할 수 없어 비운다)
      const sameUnit = s.lines.every((l) => l.unit !== "KG") || s.lines.every((l) => l.unit === "KG");
      pages.push({ storage: s.storage, lines, total: last && sameUnit ? s.lines.reduce((t, l) => t + l.qty, 0) : null });
    }
  }
  const c = doc.company;

  return (
    <div className="fac-od">
      <div className="fac-od-bar">
        <span>출고증 {doc.doc_no} · {pages.length}장</span>
        <button type="button" className="b2b-btn-primary" onClick={() => window.print()}>인쇄</button>
      </div>
      {pages.map((pg, i) => (
        <section key={i} className="fac-od-sheet">
          <div className="fac-od-head">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <div className="fac-od-logo">{c.logo && <img src={c.logo} alt="" />}</div>
            <h1 className="fac-od-title">出 庫 證</h1>
            <div className="fac-od-no">No. {doc.doc_no}</div>
          </div>
          <div className="fac-od-to">
            <span>{pg.storage} 貴中</span>
            <span>{[c.tel && `Tel: ${c.tel}`, c.fax && `Fax: ${c.fax}`].filter(Boolean).join("    ")}</span>
          </div>
          <table className="fac-od-table">
            <thead><tr><th>품 명</th><th>규 격</th><th>본선명</th><th>적요</th><th>단위</th><th>수 량</th><th>입고일자</th></tr></thead>
            <tbody>
              {Array.from({ length: OUT_DOC_ROWS }, (_, r) => {
                const l = pg.lines[r];
                return (
                  <tr key={r}>
                    <td>{l?.name}</td><td>{l?.spec}</td><td>{l?.vessel}</td><td className="is-left">{l?.memo}</td>
                    <td>{l?.unit}</td><td>{l ? qty(l.qty) : ""}</td><td>{l?.in_date}</td>
                  </tr>
                );
              })}
              <tr><td>계</td><td></td><td></td><td></td><td></td><td>{pg.total == null ? "" : qty(pg.total)}</td><td></td></tr>
            </tbody>
          </table>
          <div className="fac-od-body">
            <p>상기 품명 및 수량을 <u className="fac-od-partner">{doc.partner || "　　　　　　"}</u> 에게</p>
            <p>출고하여 주시기 바랍니다.</p>
            <p className="is-in">출고자/차량번호:</p>
            <p className="is-in">출고일자　　{longDate(doc.out_date)}</p>
            <p>(단 냉장료는　{longDate(nextDay(doc.out_date))}　부터 출고자 부담임)</p>
            <p className="is-in">발행일자: {issued(doc.issued_at)}</p>
          </div>
          <div className="fac-od-foot">
            <div className="fac-od-co">{c.name}</div>
            <div className="fac-od-co-info">
              <div>
                {c.ceo && <p>대표 : {c.ceo}</p>}
                {c.tel && <p>TEL : {c.tel}</p>}
                {c.fax && <p>FAX : {c.fax}</p>}
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <div className="fac-od-seal">{c.seal && <img src={c.seal} alt="" />}</div>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
