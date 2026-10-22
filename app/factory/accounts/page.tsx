"use client";

// 파도소리 계정(관리자) — 직원 계정을 만들어 비밀번호를 나눠 준다(2026-10-22 대표 지시).
//  로그인은 비밀번호만으로 하므로 사람마다 다른 비밀번호. 이미 쓰는 비밀번호는 서버가 거절한다.
//  파도소리(role=factory) 계정만 보이고 다룬다.

import { useCallback, useEffect, useState } from "react";

type Account = { id: string; name: string; active: boolean; created_at: string };

// 읽기 쉬운 비밀번호 — 헷갈리는 글자(0·O·1·l·I) 제외, 8자
const CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
function makePassword(): string {
  const a = new Uint32Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => CHARS[n % CHARS.length]).join("");
}
const day = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);

export default function FactoryAccountsPage() {
  const [users, setUsers] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [pwFor, setPwFor] = useState<string | null>(null); // 비밀번호 바꾸는 줄
  const [newPw, setNewPw] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const j = await (await fetch("/api/factory/accounts", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setUsers(j.users || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 실패"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function call(method: string, body?: Record<string, unknown>, query = "") {
    const res = await fetch(`/api/factory/accounts${query}`, {
      method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) throw new Error(j.error || "실패");
  }
  async function run(fn: () => Promise<void>, ok: string) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); setNotice(ok); await load(); } catch (e) { setError(e instanceof Error ? e.message : "실패"); }
    setBusy(false);
  }

  const add = () => run(async () => {
    await call("POST", { name, password });
    setName(""); setPassword("");
  }, `${name.trim()} 계정을 만들었습니다. 비밀번호: ${password.trim()}`);

  const savePw = (u: Account) => run(async () => {
    await call("PATCH", { id: u.id, password: newPw });
    setPwFor(null); setNewPw("");
  }, `${u.name} 비밀번호를 바꿨습니다: ${newPw.trim()}`);

  return (
    <div className="b2b-container fac-accounts">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">계정</h1></div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {notice && <div className="sm-success">{notice}</div>}

      <div className="fac-acc-add">
        <label className="fac-f">
          <span>이름</span>
          <input className="b2b-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="홍길동" />
        </label>
        <label className="fac-f">
          <span>비밀번호</span>
          <input className="b2b-input" value={password} onChange={(e) => setPassword(e.target.value)} spellCheck={false} autoComplete="off" />
        </label>
        <button type="button" className="b2b-btn-secondary" onClick={() => setPassword(makePassword())}>자동 생성</button>
        <button type="button" className="b2b-btn-primary" onClick={add} disabled={busy || !name.trim() || !password.trim()}>추가</button>
      </div>

      {loading ? <div className="b2b-loading">불러오는 중...</div> : users.length === 0 ? (
        <div className="b2b-empty">계정이 없습니다.</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table is-responsive">
            <thead><tr><th>이름</th><th>상태</th><th>만든 날</th><th></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.active ? "" : "fac-row-off"}>
                  <td data-label="이름"><strong>{u.name}</strong></td>
                  <td data-label="상태">{u.active ? "사용" : <span className="b2b-status-pill fac-pill-off">중지</span>}</td>
                  <td data-label="만든 날" className="sm-nowrap">{day(u.created_at)}</td>
                  <td className="actions">
                    {pwFor === u.id ? (
                      <span className="fac-acc-pw">
                        <input className="b2b-input" value={newPw} onChange={(e) => setNewPw(e.target.value)} spellCheck={false} autoComplete="off" aria-label="새 비밀번호" />
                        <button type="button" className="b2b-link-btn" onClick={() => setNewPw(makePassword())}>자동 생성</button>
                        <button type="button" className="b2b-link-btn" onClick={() => savePw(u)} disabled={busy || !newPw.trim()}>저장</button>
                        <button type="button" className="b2b-link-btn" onClick={() => { setPwFor(null); setNewPw(""); }}>닫기</button>
                      </span>
                    ) : (
                      <>
                        <button type="button" className="b2b-link-btn" onClick={() => { setPwFor(u.id); setNewPw(""); }}>비밀번호 변경</button>
                        <button type="button" className="b2b-link-btn" disabled={busy}
                          onClick={() => run(() => call("PATCH", { id: u.id, active: !u.active }), u.active ? `${u.name} 계정을 중지했습니다.` : `${u.name} 계정을 다시 켰습니다.`)}>
                          {u.active ? "중지" : "다시 사용"}
                        </button>
                        <button type="button" className="b2b-link-btn fac-cancel" disabled={busy}
                          onClick={() => { if (window.confirm(`${u.name} 계정을 삭제할까요?`)) run(() => call("DELETE", undefined, `?id=${encodeURIComponent(u.id)}`), `${u.name} 계정을 삭제했습니다.`); }}>
                          삭제
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
