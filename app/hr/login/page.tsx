"use client";

// 급여·연차 창 로그인 — 업무도우미 로그인(/b2b/login)·파도소리 로그인과 완전히 다른 화면·다른 API(/api/hr/auth).

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import "../hr.css";

export default function HrLoginPage() {
  return (
    <Suspense fallback={<div className="b2b-loading">불러오는 중...</div>}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const params = useSearchParams();
  const raw = params.get("redirect") || "/hr";
  // 급여 창 안의 주소로만 돌아간다(바깥 주소·다른 구역으로의 이탈 방지)
  const redirect = raw === "/hr" || raw.startsWith("/hr/") ? raw : "/hr";
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) { setError("비밀번호를 입력하세요"); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/hr/auth", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error || "들어가지 못했습니다.");
      window.location.href = redirect; // 새로 불러와 쿠키가 실린 상태로 시작한다
    } catch (err) {
      setError(err instanceof Error ? err.message : "들어가지 못했습니다.");
      setPassword("");
      setLoading(false);
    }
  }

  return (
    <div className="hr-login">
      <div className="hr-login-card">
        <h1 className="hr-login-title">급여·연차</h1>
        <form onSubmit={handleSubmit}>
          <label className="b2b-field">
            <span className="b2b-field-label">비밀번호</span>
            <input
              type="password"
              className="b2b-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              autoFocus
              disabled={loading}
              aria-invalid={error ? "true" : undefined}
            />
          </label>
          {error && <div className="b2b-error" role="alert">{error}</div>}
          <button type="submit" className="b2b-btn-primary" disabled={loading}>
            {loading ? "확인 중..." : "들어가기"}
          </button>
        </form>
      </div>
    </div>
  );
}
