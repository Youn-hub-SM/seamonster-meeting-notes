"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

interface Entry {
  id: string;
  category: string;
  title: string;
  content: string;
  sort_order: number;
  _new?: boolean;
  _saving?: boolean;
  _dirty?: boolean;
  _saved?: boolean;
}

export default function CsManualPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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
      if (!res.ok || !j.ok) throw new Error(j.error || "조회 실패");
      setEntries((j.entries || []).map((e: Entry) => ({ ...e, category: e.category || "일반" })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
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
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (filterCat && (e.category || "일반") !== filterCat) return false;
      if (!q) return true;
      return [e.title, e.content, e.category].filter(Boolean).some((v) => v.toLowerCase().includes(q));
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
      setError("제목을 입력하세요.");
      return;
    }
    setError("");
    patchById(e.id, { _saving: true });
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
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      patchById(e.id, { id: j.entry.id, _new: false, _saving: false, _dirty: false, _saved: true });
      setTimeout(() => patchById(j.entry.id, { _saved: false }), 1800);
    } catch (err) {
      patchById(e.id, { _saving: false });
      setError(err instanceof Error ? err.message : "저장 중 오류");
    }
  }

  async function remove(e: Entry) {
    if (e._new) {
      setEntries((prev) => prev.filter((x) => x.id !== e.id));
      return;
    }
    if (!confirm(`"${e.title}" 항목을 삭제할까요?`)) return;
    try {
      const res = await fetch(`/api/cs/manual?id=${encodeURIComponent(e.id)}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "삭제 실패");
      setEntries((prev) => prev.filter((x) => x.id !== e.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 중 오류");
    }
  }

  return (
    <div className="container">
      <div className="csm-head">
        <div>
          <h1 className="page-title">CS 매뉴얼 (지식베이스)</h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            CS 코치가 답변할 때 근거로 쓰는 매뉴얼입니다. 여기서 추가·수정·삭제하면 코드 수정 없이 바로 반영됩니다.
          </p>
        </div>
        <Link href="/cs" className="btn-secondary csm-back">← CS 코치로</Link>
      </div>

      {error && <p style={{ color: "var(--sm-danger)", margin: "12px 0", fontSize: 12 }}>{error}</p>}

      {/* 검색 + 카테고리 필터 + 추가 */}
      {!loading && (
        <div className="csm-toolbar">
          <input
            className="csm-search"
            placeholder="제목·내용·카테고리 검색"
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
        <p style={{ color: "var(--sm-text-light)", padding: "32px 0" }}>불러오는 중...</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: "var(--sm-text-light)", padding: "32px 0" }}>
          {entries.length === 0 ? "등록된 매뉴얼이 없습니다. 항목을 추가하세요." : "검색 결과가 없습니다."}
        </p>
      ) : (
        <div className="csm-list">
          {filtered.map((e) => (
            <div key={e.id} className={`csm-card ${e._new ? "is-new" : ""}`}>
              <div className="csm-card-row">
                <input
                  className="csm-title-input"
                  value={e.title}
                  placeholder="항목 제목 (예: 배송 지연, 이유식 가시 보상)"
                  onChange={(ev) => patchById(e.id, { title: ev.target.value, _dirty: true })}
                />
                <input
                  className="csm-cat-input"
                  list="cs-cats"
                  value={e.category}
                  placeholder="카테고리"
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
              <textarea
                className="form-textarea csm-content"
                value={e.content}
                placeholder="이 항목의 매뉴얼 내용을 입력하세요."
                onChange={(ev) => patchById(e.id, { content: ev.target.value, _dirty: true })}
              />
              <div className="csm-card-actions">
                <button
                  className="btn-primary"
                  onClick={() => save(e)}
                  disabled={e._saving || (!e._dirty && !e._new)}
                >
                  {e._saving ? "저장 중..." : e._saved ? "저장됨 ✓" : e._dirty || e._new ? "저장" : "변경 없음"}
                </button>
                <button className="btn-danger" onClick={() => remove(e)}>삭제</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
