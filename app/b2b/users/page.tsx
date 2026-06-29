"use client";

import { useCallback, useEffect, useState } from "react";

type AppUser = { id: string; name: string; active: boolean; created_at: string };

export default function UsersPage() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [envUsers, setEnvUsers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/b2b/users", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "조회 실패");
      setUsers(j.users || []); setEnvUsers(j.envUsers || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!name.trim() || !password.trim()) { setError("이름과 비밀번호를 입력하세요."); return; }
    setSaving(true); setError("");
    try {
      const res = await fetch("/api/b2b/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, password }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "추가 실패");
      setName(""); setPassword(""); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "추가 실패"); }
    setSaving(false);
  }
  async function toggle(u: AppUser) {
    await fetch("/api/b2b/users", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: u.id, active: !u.active }) });
    await load();
  }
  async function remove(u: AppUser) {
    if (!window.confirm(`'${u.name}' 계정을 삭제할까요?`)) return;
    await fetch(`/api/b2b/users?id=${encodeURIComponent(u.id)}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">로그인 계정 관리</h1>
          <p className="b2b-page-subtitle">여기서 추가한 계정은 즉시 로그인할 수 있습니다(재배포 불필요). 비밀번호로 사용자를 구분합니다.</p>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{error.includes("app_users") || error.includes("relation") ? " — supabase/migrations/026_app_users.sql 를 먼저 적용하세요." : ""}</div>}

      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">계정 추가</span></div>
        <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input className="b2b-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="이름(예: 민수)" style={{ flex: 1, minWidth: 160 }} />
          <input className="b2b-input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="비밀번호(서로 달라야 함)" style={{ flex: 1, minWidth: 160 }} />
          <button className="b2b-btn-primary" onClick={add} disabled={saving}>{saving ? "추가 중…" : "추가"}</button>
        </div>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>비밀번호 자체가 신원이라 사람마다 서로 다른 값으로 정하세요.</p>
      </section>

      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">계정 목록</span></div>
        {loading ? <div className="b2b-loading">불러오는 중...</div> : (
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr><th>이름</th><th>구분</th><th>상태</th><th>추가일</th><th></th></tr></thead>
              <tbody>
                {envUsers.map((n) => (
                  <tr key={`env-${n}`}><td>{n}</td><td className="sm-faint">환경변수(고정)</td><td><span className="b2b-feed-pill" style={{ background: "var(--sm-success-bg)", color: "var(--sm-success)" }}>활성</span></td><td>-</td><td></td></tr>
                ))}
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td className="sm-faint">추가됨</td>
                    <td>
                      <button className="b2b-feed-pill" onClick={() => toggle(u)} style={{ cursor: "pointer", border: "none", background: u.active ? "var(--sm-success-bg)" : "var(--sm-bg-subtle)", color: u.active ? "var(--sm-success)" : "var(--sm-text-mid)" }}>{u.active ? "활성" : "비활성"}</button>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{u.created_at?.slice(0, 10)}</td>
                    <td><button className="b2b-link-btn" onClick={() => remove(u)} style={{ color: "var(--sm-danger)" }}>삭제</button></td>
                  </tr>
                ))}
                {!loading && users.length === 0 && envUsers.length === 0 && <tr><td colSpan={5} className="sm-faint">계정이 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
