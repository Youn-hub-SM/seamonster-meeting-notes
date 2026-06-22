"use client";

import { useEffect, useRef, useState } from "react";

export type ComboOption = { id: string; label: string; sub?: string };

// 입력 시 리스트가 추천 키워드처럼 필터돼 뜨는 콤보박스.
//  - 업체: 리스트에서만 선택(allowFreeText=false) → onSelect 로 id 확정
//  - 제품: 선택 또는 자유 입력(allowFreeText) → onSelect(기존 제품) / onType(자유 텍스트)
// 드롭다운은 position:fixed 로 띄워 테이블 overflow 에 잘리지 않음.
export function Combobox({
  value,
  options,
  onSelect,
  onType,
  placeholder,
  allowFreeText = false,
  emptyText,
  ariaLabel,
}: {
  value: string;
  options: ComboOption[];
  onSelect: (opt: ComboOption) => void;
  onType?: (text: string) => void;
  placeholder?: string;
  allowFreeText?: boolean;
  emptyText?: string;
  ariaLabel?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null); // null = value 표시, 아니면 편집중
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const [active, setActive] = useState(0);

  const text = query ?? value ?? "";
  const q = (query ?? "").trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.sub || "").toLowerCase().includes(q))
    : options;

  function updateCoords() {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({ top: r.bottom + 2, left: r.left, width: r.width });
  }
  function openList() {
    updateCoords();
    setActive(0);
    setOpen(true);
  }
  function close() {
    setOpen(false);
    setQuery(null);
  }
  function choose(o: ComboOption) {
    onSelect(o);
    close();
  }

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onMove = () => updateCoords();
    document.addEventListener("mousedown", onDocDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  return (
    <div className="b2b-combo" ref={wrapRef}>
      <input
        ref={inputRef}
        className="b2b-combo-input"
        type="text"
        value={text}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        onFocus={(e) => {
          openList();
          e.currentTarget.select();
        }}
        onChange={(e) => {
          const v = e.target.value;
          setQuery(v);
          if (!open) openList();
          else updateCoords();
          setActive(0);
          if (allowFreeText) onType?.(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            close();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            if (open && filtered[active]) {
              e.preventDefault();
              choose(filtered[active]);
            }
          }
        }}
      />
      {open && coords && (
        <div
          className="b2b-combo-list"
          style={{ position: "fixed", top: coords.top, left: coords.left, width: coords.width }}
        >
          {filtered.length === 0 ? (
            <div className="b2b-combo-empty">
              {emptyText ?? (allowFreeText ? "일치 없음 — 입력한 대로 사용됩니다" : "결과 없음")}
            </div>
          ) : (
            filtered.map((o, i) => (
              <button
                type="button"
                key={o.id}
                className={`b2b-combo-opt${i === active ? " is-active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="b2b-combo-opt-label">{o.label}</span>
                {o.sub && <span className="b2b-combo-sub">{o.sub}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
