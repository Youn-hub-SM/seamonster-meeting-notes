"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="b2b-loading">불러오는 중...</div>}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirect = params.get("redirect") || "/b2b";
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
      // 인증 성공 → redirect 로 이동. router.refresh 로 서버 컴포넌트 다시 로드.
      router.push(redirect);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인 중 오류");
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "calc(100vh - 60px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 20,
      background: "var(--sm-bg)",
    }}>
      <div style={{ width: "100%", maxWidth: 360 }}>
        {/* 브랜드 */}
        <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--sm-dark)", margin: "0 0 20px", textAlign: "center", letterSpacing: "-0.3px" }}>
          씨몬스터 업무 도우미
        </h1>

        {/* 로그인 카드 */}
        <div style={{
          background: "var(--sm-white)",
          border: "1px solid var(--sm-border)",
          borderRadius: 16,
          padding: "26px 24px",
          boxShadow: "0 12px 32px rgba(0,0,0,0.07)",
        }}>
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
            {error && (
              <div style={{
                fontSize: 12,
                color: "var(--sm-danger)",
                padding: "8px 12px",
                background: "var(--sm-danger-bg)",
                borderRadius: 8,
                marginBottom: 12,
              }}>
                {error}
              </div>
            )}
            <button
              type="submit"
              className="b2b-btn-primary"
              disabled={loading || !password}
              style={{ width: "100%" }}
            >
              {loading ? "확인 중..." : "들어가기"}
            </button>
          </form>
        </div>

        <p style={{ textAlign: "center", fontSize: 11, color: "var(--sm-text-light)", marginTop: 16 }}>
          © 2026 seamonster corp. All rights reserved.
        </p>
      </div>
    </div>
  );
}
