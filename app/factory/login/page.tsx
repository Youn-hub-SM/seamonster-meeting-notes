"use client";

// 파도소리 전용 로그인 — 씨몬스터 로그인(/b2b/login)과 완전히 분리된 화면.
// 검증은 같은 /api/b2b/auth 를 쓴다(비밀번호가 신원, 역할은 서버가 판단).

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import "../factory.css";

export default function FactoryLoginPage() {
  return (
    <Suspense fallback={<div className="b2b-loading">불러오는 중...</div>}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("redirect") || "/factory";
  const redirect = raw.startsWith("/") ? raw : "/factory"; // 외부 주소로의 이탈 방지
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => { document.title = "파도소리 재고관리"; }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "로그인 실패");
      router.push(redirect);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인 중 오류");
      setLoading(false);
    }
  }

  return (
    <div className="fac-theme fac-login">
      <div style={{ width: "100%", maxWidth: 360 }}>
        <div className="fac-login-card">
          <h1 className="fac-login-title">파도소리</h1>
          <p className="fac-login-sub">재고관리</p>
          <label style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-text-mid)", display: "block", marginBottom: 8 }}>
            비밀번호
          </label>
          <form onSubmit={handleSubmit}>
            <input
              type="password"
              className="b2b-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호를 입력하세요"
              autoComplete="current-password"
              autoFocus
              disabled={loading}
              style={{ marginBottom: 12 }}
            />
            {error && <div className="b2b-error" style={{ marginBottom: 12 }}>{error}</div>}
            <button type="submit" className="b2b-btn-primary" disabled={loading || !password} style={{ width: "100%" }}>
              {loading ? "확인 중..." : "들어가기"}
            </button>
          </form>
        </div>
        <p style={{ textAlign: "center", fontSize: 12, color: "var(--sm-text-light)", marginTop: 16 }}>
          © 2026 padosori. All rights reserved.
        </p>
      </div>
    </div>
  );
}
