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
      <div style={{
        background: "var(--sm-white)",
        border: "1px solid var(--sm-border)",
        borderRadius: 16,
        padding: "32px 28px",
        width: "100%",
        maxWidth: 360,
        boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
      }}>
        <div style={{ fontSize: 35, marginBottom: 8 }}>🔒</div>
        <h1 style={{ fontSize: 19, fontWeight: 700, marginBottom: 6 }}>B2B 관리툴</h1>
        <p style={{ fontSize: 12, color: "var(--sm-text-mid)", marginBottom: 20 }}>
          비밀번호를 입력하세요.
        </p>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            className="b2b-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="비밀번호"
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
    </div>
  );
}
