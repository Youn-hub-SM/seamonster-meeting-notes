"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/app/components/Feedback";
import Link from "next/link";
import { matchKoQuery } from "@/app/lib/hangul";

interface Entry {
  id: string;
  category: string;
  title: string;
  content: string;
  sort_order: number;
  _new?: boolean;
  _saving?: boolean;
  _invalid?: boolean; // 저장 때 제목이 비어 있던 항목(제목 칸 빨강)
  _dirty?: boolean;
  _saved?: boolean;
}

export default function CsManualPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const confirmModal = useConfirm();
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("");
  const newCounter = useRef(0);
  const addHandled = useRef(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/cs/manual", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "매뉴얼을 불러오지 못했습니다. 새로고침하세요");
      setEntries((j.entries || []).map((e: Entry) => ({ ...e, category: e.category || "일반" })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "매뉴얼을 불러오지 못했습니다. 새로고침하세요");
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  // CS 코치의 '미등록' → 원클릭 추가: ?add=<상황> 로 들어오면 새 항목 자동 생성
  useEffect(() => {
    if (loading || addHandled.current) return;
    const q = new URLSearchParams(window.location.search).get("add");
    if (q && q.trim()) {
      addHandled.current = true;
      addNew(`■ 이런 상황·문의\n${q.trim()}\n\n■ 이렇게 응대\n(여기에 응대 방법을 적어주세요)`);
      // URL 정리 (새로고침 시 중복 추가 방지)
      window.history.replaceState(null, "", "/cs/manual");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => set.add(e.category || "일반"));
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ko"));
  }, [entries]);

  const filtered = useMemo(() => {
    const q = search.trim();
    return entries.filter((e) => {
      if (filterCat && (e.category || "일반") !== filterCat) return false;
      if (!q) return true;
      return matchKoQuery([e.title, e.content, e.category].filter(Boolean).join(" "), q);
    });
  }, [entries, search, filterCat]);

  function patchById(id: string, p: Partial<Entry>) {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...p } : e)));
  }

  function addNew(prefillContent = "") {
    newCounter.current += 1;
    const id = `new-${newCounter.current}`;
    const maxOrder = entries.reduce((m, e) => Math.max(m, e.sort_order || 0), 0);
    setEntries((prev) => [
      { id, category: filterCat || "일반", title: "", content: prefillContent, sort_order: maxOrder + 1, _new: true, _dirty: true },
      ...prev,
    ]);
    setSearch("");
  }

  async function save(e: Entry) {
    if (!e.title.trim()) {
      setError("제목을 입력하세요");
      patchById(e.id, { _invalid: true });
      return;
    }
    setError("");
    patchById(e.id, { _saving: true, _invalid: false });
    try {
      const isNew = e._new;
      const res = await fetch("/api/cs/manual", {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: isNew ? undefined : e.id,
          category: e.category,
          title: e.title,
          content: e.content,
          sort_order: e.sort_order,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "항목을 저장하지 못했습니다. 제목과 내용을 확인하세요");
      patchById(e.id, { id: j.entry.id, _new: false, _saving: false, _dirty: false, _saved: true });
      setTimeout(() => patchById(j.entry.id, { _saved: false }), 1800);
    } catch (err) {
      patchById(e.id, { _saving: false });
      setError(err instanceof Error ? err.message : "항목을 저장하지 못했습니다. 제목과 내용을 확인하세요");
    }
  }

  async function remove(e: Entry) {
    if (e._new) {
      setEntries((prev) => prev.filter((x) => x.id !== e.id));
      return;
    }
    if (!(await confirmModal({ title: `"${e.title}" 항목 삭제`, body: "매뉴얼에서 이 항목이 지워집니다. 되돌릴 수 없습니다.", action: "항목 삭제" }))) return;
    try {
      const res = await fetch(`/api/cs/manual?id=${encodeURIComponent(e.id)}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "항목을 삭제하지 못했습니다. 새로고침한 뒤 다시 하세요");
      setEntries((prev) => prev.filter((x) => x.id !== e.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "항목을 삭제하지 못했습니다. 새로고침한 뒤 다시 하세요");
    }
  }

  return (
    <div className="container">
      <div className="csm-head">
        <div>
          <h1 className="page-title">CS 매뉴얼 (지식베이스)</h1>
        </div>
        <Link href="/report" className="btn-secondary csm-back">AI 비서로 가기</Link>
      </div>

      {error && <div className="b2b-error" style={{ margin: "12px 0" }}>{error}</div>}

      {/* 검색 + 카테고리 필터 + 추가 */}
      {!loading && (
        <div className="csm-toolbar">
          <input
            className="csm-search"
            placeholder="검색"
            aria-label="매뉴얼 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="csm-cat-filter" value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
            <option value="">전체 카테고리</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button className="btn-primary csm-add-btn" onClick={() => addNew()}>+ 항목 추가</button>
        </div>
      )}

      <datalist id="cs-cats">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : filtered.length === 0 ? (
        <div className="b2b-empty">
          {entries.length === 0 ? "등록된 매뉴얼이 없습니다." : "조건에 맞는 매뉴얼이 없습니다."}
          <div className="b2b-empty-action">
            {entries.length === 0
              ? <button type="button" className="btn-secondary" onClick={() => addNew()}>+ 항목 추가</button>
              : <button type="button" className="btn-secondary" onClick={() => { setSearch(""); setFilterCat(""); }}>조건 지우기</button>}
          </div>
        </div>
      ) : (
        <div className="csm-list">
          {filtered.map((e) => (
            <div key={e.id} className={`csm-card ${e._new ? "is-new" : ""}`}>
              <div className="csm-card-row">
                <input
                  className="csm-title-input"
                  value={e.title}
                  placeholder="예: 배송 지연"
                  aria-label="항목 제목"
                  aria-invalid={e._invalid && !e.title.trim() ? "true" : undefined}
                  onChange={(ev) => patchById(e.id, { title: ev.target.value, _dirty: true })}
                />
                <input
                  className="csm-cat-input"
                  list="cs-cats"
                  value={e.category}
                  placeholder="예: 배송"
                  aria-label="카테고리"
                  onChange={(ev) => patchById(e.id, { category: ev.target.value, _dirty: true })}
                />
                <span className="csm-order">
                  순서
                  <input
                    type="number"
                    className="csm-order-input"
                    value={e.sort_order}
                    onChange={(ev) => patchById(e.id, { sort_order: Number(ev.target.value) || 0, _dirty: true })}
                  />
                </span>
              </div>
              {e._invalid && !e.title.trim() && <div className="b2b-field-error">제목을 입력하세요</div>}
              <textarea
                className="form-textarea csm-content"
                value={e.content}
                aria-label="매뉴얼 내용"
                onChange={(ev) => patchById(e.id, { content: ev.target.value, _dirty: true })}
              />
              <div className="csm-card-actions">
                <button
                  className="btn-primary"
                  onClick={() => save(e)}
                  disabled={e._saving || (!e._dirty && !e._new)}
                >
                  {e._saving ? "저장 중..." : e._saved ? "저장했습니다" : e._new ? "항목 저장" : e._dirty ? "변경 저장" : "변경 없음"}
                </button>
                <button className="btn-danger" onClick={() => remove(e)}>항목 삭제</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
