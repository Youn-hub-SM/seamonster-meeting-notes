"use client";

// 전역 검색(Ctrl+K / Cmd+K) — 메뉴·가이드 항목·발주번호·거래처·품목(SKU)을 한 칸에서. 2026-10-14 UX 3차 C5.
//  원칙(docs/ux-affordance-plan.md §1-1): 검색은 보조다 — 보이는 메뉴를 대신하지 않는 숙련자용 지름길.
//  결과는 '이동 / 가이드 / 데이터' 세 묶음. 이동 = app/nav.ts NAV(관리자 전용은 관리자만), 가이드 = app/lib/guide-search.ts
//  (/guide 와 같은 매처), 데이터 = GET /api/search?q= (2글자 이상, 250ms 디바운스, 이전 요청 취소).
//  장착은 AppShell — 로그인 전·파도소리 계정(role factory)·/b2b/login·/factory 에선 아무것도 그리지 않고 단축키도 안 건다.
//  모양은 globals.css .sm-search-* (b2b.css .b2b-modal-backdrop 위에 상단 정렬).

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { NAV } from "../nav";
import { matchKoQuery } from "../lib/hangul";
import { searchGuide } from "../lib/guide-search";

type Group = "nav" | "guide" | "data";
type Hit = { key: string; group: Group; label: string; sub?: string; href: string; external?: boolean };
type DataHit = { kind: string; id: string; label: string; sub: string; href: string };

const GROUP_TITLE: Record<Group, string> = { nav: "이동", guide: "가이드", data: "데이터" };
const NAV_LIMIT = 8;
const GUIDE_LIMIT = 6;
const isExternal = (href: string) => /^https?:\/\//.test(href);

// NAV 를 '분류 › 툴 › 하위' 한 줄짜리 항목으로 편다. 같은 주소가 툴과 첫 하위 메뉴에 같이 있으면(B2B = 발주) 하위 쪽만 남긴다 —
//  더 구체적인 이름이 검색에 걸려야 한다. AppSidebar 와 같은 isAdmin 규칙으로 관리자 전용을 거른다.
function buildNavIndex(isAdmin: boolean): { label: string; hay: string; href: string }[] {
  const out: { label: string; hay: string; href: string }[] = [];
  const seen = new Set<string>();
  const push = (href: string, label: string, hay: string) => {
    if (seen.has(href)) return;
    seen.add(href);
    out.push({ href, label, hay });
  };
  for (const cat of NAV) {
    if (cat.adminOnly && !isAdmin) continue;
    for (const t of cat.tools) {
      if (t.adminOnly && !isAdmin) continue;
      const menu = (t.menu || []).filter((m) => !m.adminOnly || isAdmin);
      const base = cat.label ? `${cat.label} › ${t.label}` : t.label;
      if (!menu.some((m) => m.href === t.href)) push(t.href, base, `${cat.label} ${t.label}`);
      for (const m of menu) push(m.href, `${base} › ${m.label}`, `${cat.label} ${t.label} ${m.label}`);
    }
  }
  return out;
}

export default function GlobalSearch({ open, onOpen, onClose }: { open: boolean; onOpen: () => void; onClose: () => void }) {
  const router = useRouter();
  // 로그인 사용자·역할 — /api/b2b/auth 는 미들웨어 예외라 어디서나 호출 가능(AppSidebar 와 같은 출처). 열 때마다 다시 확인한다.
  const [auth, setAuth] = useState<{ name: string | null; role: string } | null>(null);
  useEffect(() => {
    if (auth && !open) return;
    fetch("/api/b2b/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setAuth({ name: j?.ok ? j.name || null : null, role: j?.ok ? j.role || "internal" : "internal" }))
      .catch(() => setAuth({ name: null, role: "internal" }));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const enabled = !!auth?.name && auth.role !== "factory";
  const isAdmin = auth?.name === "현석" || auth?.name === "관리자"; // AppSidebar 와 같은 규칙

  // Ctrl+K(맥 Cmd+K) — 열려 있으면 닫는다. 로그인 전·파도소리 계정엔 걸지 않는다.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "k" && e.code !== "KeyK") return;
      e.preventDefault();
      if (open) onClose(); else onOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, open, onOpen, onClose]);

  if (!enabled || !open) return null;
  return <SearchPanel isAdmin={isAdmin} onClose={onClose} navigate={(href, external) => {
    onClose();
    if (external) window.open(href, "_blank", "noopener,noreferrer");
    else router.push(href);
  }} />;
}

// 패널은 열릴 때마다 새로 마운트 — 검색어·선택이 자동으로 초기화된다(최근 검색은 저장하지 않는다).
function SearchPanel({ isAdmin, onClose, navigate }: { isAdmin: boolean; onClose: () => void; navigate: (href: string, external?: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<DataHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim();

  const navIndex = useMemo(() => buildNavIndex(isAdmin), [isAdmin]);

  // 이동·가이드는 클라이언트에서 즉시, 데이터는 API(250ms 디바운스 + 이전 요청 취소)
  const navHits = useMemo<Hit[]>(() => {
    if (!q) return [];
    return navIndex.filter((n) => matchKoQuery(n.hay, q)).slice(0, NAV_LIMIT)
      .map((n) => ({ key: `nav:${n.href}`, group: "nav", label: n.label, href: n.href, external: isExternal(n.href) }));
  }, [navIndex, q]);
  const guideHits = useMemo<Hit[]>(() => {
    if (!q) return [];
    const href = `/guide?q=${encodeURIComponent(q)}`;
    return searchGuide(q, GUIDE_LIMIT).map((g) => ({ key: `guide:${g.entry.href}:${g.entry.label}`, group: "guide", label: g.entry.label, sub: g.tool, href }));
  }, [q]);
  useEffect(() => {
    if (q.length < 2) { setData([]); setLoading(false); return; }
    const ctrl = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal, cache: "no-store" })
        .then((r) => r.json())
        .then((j) => { setData(j?.ok && Array.isArray(j.data) ? j.data : []); setLoading(false); })
        .catch((err) => { if (err?.name !== "AbortError") { setData([]); setLoading(false); } });
    }, 250);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [q]);
  const dataHits = useMemo<Hit[]>(
    () => data.map((d) => ({ key: `data:${d.kind}:${d.id}`, group: "data", label: d.label, sub: d.sub, href: d.href })),
    [data]
  );

  const groups = useMemo(() => (
    [{ group: "nav" as Group, hits: navHits }, { group: "guide" as Group, hits: guideHits }, { group: "data" as Group, hits: dataHits }]
      .filter((g) => g.hits.length > 0)
  ), [navHits, guideHits, dataHits]);
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  // 결과가 바뀌면 첫 항목으로. 키보드로 고른 항목은 목록 안에서 보이게 스크롤.
  useEffect(() => { setActive(0); }, [flat]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (h: Hit) => navigate(h.href, h.external);
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter/방향키는 입력기 몫
    if (e.key === "ArrowDown") { e.preventDefault(); if (flat.length) setActive((i) => (i + 1) % flat.length); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); if (flat.length) setActive((i) => (i - 1 + flat.length) % flat.length); return; }
    if (e.key === "Enter") { e.preventDefault(); const h = flat[active]; if (h) choose(h); }
  };

  const showEmpty = !!q && flat.length === 0 && !loading;
  const activeId = flat[active] ? `sm-search-opt-${active}` : undefined;
  let idx = -1;

  return (
    <div className="b2b-modal-backdrop sm-search-backdrop" onClick={onClose}>
      <div className="sm-search" role="dialog" aria-modal="true" aria-label="전역 검색" onClick={(e) => e.stopPropagation()}>
        <input
          type="text"
          className="sm-search-input"
          placeholder="검색"
          aria-label="전역 검색"
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls="sm-search-list"
          aria-activedescendant={activeId}
          autoComplete="off"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {q && (groups.length > 0 || showEmpty) && (
          <div className="sm-search-list" id="sm-search-list" role="listbox" aria-label="검색 결과" ref={listRef}>
            {groups.map((g) => (
              <div key={g.group} className="sm-search-group" role="group" aria-label={GROUP_TITLE[g.group]}>
                <div className="sm-search-group-title">{GROUP_TITLE[g.group]}</div>
                {g.hits.map((h) => {
                  idx += 1;
                  const i = idx;
                  return (
                    <div
                      key={h.key}
                      id={`sm-search-opt-${i}`}
                      data-idx={i}
                      role="option"
                      aria-selected={i === active}
                      className={`sm-search-item ${i === active ? "is-active" : ""}`}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => e.preventDefault()} /* 입력칸 초점 유지 */
                      onClick={() => choose(h)}
                    >
                      <span className="sm-search-item-label">{h.label}{h.external && <span className="sm-search-ext" aria-hidden="true"> ↗</span>}</span>
                      {h.sub && <span className="sm-search-item-sub">{h.sub}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
            {showEmpty && <div className="sm-search-empty">결과가 없습니다</div>}
          </div>
        )}
      </div>
    </div>
  );
}
