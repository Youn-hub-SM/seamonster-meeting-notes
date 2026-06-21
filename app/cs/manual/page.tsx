"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Entry {
  id: string;
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

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/cs/manual", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "조회 실패");
      setEntries(j.entries || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function patch(idx: number, p: Partial<Entry>) {
    setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, ...p } : e)));
  }

  function addNew() {
    setEntries((prev) => [
      ...prev,
      { id: `new-${prev.length}-${prev.reduce((s, e) => s + e.title.length, 0)}`, title: "", content: "", sort_order: (prev.at(-1)?.sort_order ?? 0) + 1, _new: true, _dirty: true },
    ]);
  }

  async function save(idx: number) {
    const e = entries[idx];
    if (!e.title.trim()) {
      patch(idx, {});
      setError("제목을 입력하세요.");
      return;
    }
    setError("");
    patch(idx, { _saving: true });
    try {
      const isNew = e._new;
      const res = await fetch("/api/cs/manual", {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: isNew ? undefined : e.id,
          title: e.title,
          content: e.content,
          sort_order: e.sort_order,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      patch(idx, { id: j.entry.id, _new: false, _saving: false, _dirty: false, _saved: true });
      setTimeout(() => patch(idx, { _saved: false }), 1800);
    } catch (err) {
      patch(idx, { _saving: false });
      setError(err instanceof Error ? err.message : "저장 중 오류");
    }
  }

  async function remove(idx: number) {
    const e = entries[idx];
    if (e._new) {
      setEntries((prev) => prev.filter((_, i) => i !== idx));
      return;
    }
    if (!confirm(`"${e.title}" 항목을 삭제할까요?`)) return;
    try {
      const res = await fetch(`/api/cs/manual?id=${encodeURIComponent(e.id)}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "삭제 실패");
      setEntries((prev) => prev.filter((_, i) => i !== idx));
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

      {error && <p style={{ color: "#c92a2a", margin: "12px 0", fontSize: 14 }}>{error}</p>}

      {loading ? (
        <p style={{ color: "var(--sm-text-light)", padding: "32px 0" }}>불러오는 중...</p>
      ) : (
        <>
          <div className="csm-list">
            {entries.map((e, idx) => (
              <div key={e.id} className="csm-card">
                <div className="csm-card-row">
                  <input
                    className="csm-title-input"
                    value={e.title}
                    placeholder="항목 제목 (예: 배송 지연, 이유식 가시 보상)"
                    onChange={(ev) => patch(idx, { title: ev.target.value, _dirty: true })}
                  />
                  <span className="csm-order">
                    순서
                    <input
                      type="number"
                      className="csm-order-input"
                      value={e.sort_order}
                      onChange={(ev) => patch(idx, { sort_order: Number(ev.target.value) || 0, _dirty: true })}
                    />
                  </span>
                </div>
                <textarea
                  className="form-textarea csm-content"
                  value={e.content}
                  placeholder="이 항목의 매뉴얼 내용을 입력하세요."
                  onChange={(ev) => patch(idx, { content: ev.target.value, _dirty: true })}
                />
                <div className="csm-card-actions">
                  <button
                    className="btn-primary"
                    onClick={() => save(idx)}
                    disabled={e._saving || (!e._dirty && !e._new)}
                  >
                    {e._saving ? "저장 중..." : e._saved ? "저장됨 ✓" : e._dirty || e._new ? "저장" : "변경 없음"}
                  </button>
                  <button className="btn-danger" onClick={() => remove(idx)}>삭제</button>
                </div>
              </div>
            ))}
          </div>

          <button className="btn-secondary csm-add" onClick={addNew}>+ 항목 추가</button>
        </>
      )}
    </div>
  );
}
