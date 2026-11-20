"use client";

// 급여·연차 창 화면의 서버 호출 한 곳. 세션이 끝났으면(401) 로그인 화면으로 보낸다.

export class HrApiError extends Error {
  fields: Record<string, string>;
  pending: boolean;
  status: number;
  constructor(message: string, status: number, fields?: Record<string, string>, pending?: boolean) {
    super(message);
    this.status = status;
    this.fields = fields || {};
    this.pending = !!pending;
  }
}

function toLogin(): void {
  const here = window.location.pathname + window.location.search;
  window.location.href = here === "/hr" ? "/hr/login" : `/hr/login?redirect=${encodeURIComponent(here)}`;
}

export async function hrApi<T = Record<string, unknown>>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method, cache: "no-store", credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !url.startsWith("/api/hr/auth")) {
    toLogin();
    throw new HrApiError("로그인이 끝났습니다. 다시 들어오세요.", 401);
  }
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; fields?: Record<string, string>; pending?: boolean };
  if (!res.ok || !j.ok) throw new HrApiError(j.error || "요청을 처리하지 못했습니다.", res.status, j.fields, j.pending);
  return j as T;
}

// 파일 내려받기(엑셀) — 응답이 파일이 아니면 오류 문장을 던진다
export async function hrDownload(url: string, body: unknown, fallbackName: string): Promise<void> {
  const res = await fetch(url, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 401) { toLogin(); throw new HrApiError("로그인이 끝났습니다. 다시 들어오세요.", 401); }
  if (!res.ok || (res.headers.get("Content-Type") || "").includes("application/json")) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new HrApiError(j.error || "파일을 만들지 못했습니다.", res.status);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || fallbackName;
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = href; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export const errText = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback);
