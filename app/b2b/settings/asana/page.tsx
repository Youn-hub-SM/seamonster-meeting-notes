"use client";

import { useEffect, useState } from "react";

// 서버는 개인방 gid 와 담당자 이메일을 별도 맵으로 주므로 화면용 한 줄로 합친다(한쪽만 채운 사용자도 행으로 남는다).
function toOkrRows(map: unknown, emails: unknown): { name: string; project: string; email: string }[] {
  const m = (map || {}) as Record<string, string>;
  const e = (emails || {}) as Record<string, string>;
  const names = Array.from(new Set([...Object.keys(m), ...Object.keys(e)]));
  const rows = names.map((name) => ({ name, project: m[name] || "", email: e[name] || "" }));
  return rows.length ? rows : [{ name: "", project: "", email: "" }];
}

// 설정 · 아사나 연동 — VOC 업무 등록용 PAT·프로젝트 연결 (구 VOC 설정에서 이관, 2026-08-24 설정 재구성).
export default function AsanaSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>("");
  const [hasAsanaPat, setHasAsanaPat] = useState(false);
  const [asanaPat, setAsanaPat] = useState("");
  const [asanaProject, setAsanaProject] = useState("");
  const [asanaAssignee, setAsanaAssignee] = useState("");
  const [asanaMsg, setAsanaMsg] = useState<{ t: string; ok: boolean } | null>(null);

  // OKR 연동 — 공통 프로젝트 + 사용자별 개인 소통방 매핑
  const [okrProject, setOkrProject] = useState("");
  const [okrRows, setOkrRows] = useState<{ name: string; project: string; email: string }[]>([]);
  const [okrMsg, setOkrMsg] = useState<{ t: string; ok: boolean } | null>(null);
  const [okrBusy, setOkrBusy] = useState(false);
  const [okrTest, setOkrTest] = useState<string[]>([]);

  async function testOkr() {
    setOkrBusy(true); setOkrMsg(null); setOkrTest([]);
    try {
      const res = await fetch("/api/b2b/settings/okr", { method: "POST" });
      const j = await res.json();
      if (Array.isArray(j.lines)) setOkrTest(j.lines);
      else throw new Error(j.error || "점검 실패");
    } catch (e) { setOkrMsg({ t: e instanceof Error ? e.message : "점검 실패", ok: false }); }
    finally { setOkrBusy(false); }
  }

  useEffect(() => {
    fetch("/api/voc/asana-config", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (j.ok) { setHasAsanaPat(!!j.hasPat); setAsanaProject(j.project || ""); setAsanaAssignee(j.assignee || ""); }
    }).catch(() => {}).finally(() => setLoading(false));
    fetch("/api/b2b/settings/okr", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (j.ok) {
        setOkrProject(j.project || "");
        setOkrRows(toOkrRows(j.map, j.emails));
      }
    }).catch(() => {});
  }, []);

  async function saveOkr() {
    setOkrBusy(true); setOkrMsg(null);
    try {
      const map: Record<string, string> = {};
      const emails: Record<string, string> = {};
      for (const r of okrRows) {
        const name = r.name.trim();
        if (!name) continue;
        if (r.project.trim()) map[name] = r.project.trim();
        if (r.email.trim()) emails[name] = r.email.trim();
      }
      const res = await fetch("/api/b2b/settings/okr", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: okrProject, map, emails }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setOkrProject(j.project || "");
      setOkrRows(toOkrRows(j.map, j.emails));
      setOkrMsg({ t: "저장됨", ok: true });
    } catch (e) { setOkrMsg({ t: e instanceof Error ? e.message : "저장 실패", ok: false }); }
    finally { setOkrBusy(false); }
  }

  async function saveAsana(body: Record<string, string | boolean>, okMsg: string, tag: string) {
    setBusy(tag); setAsanaMsg(null);
    try {
      const res = await fetch("/api/voc/asana-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({ ok: false, error: `서버 응답 오류(HTTP ${res.status})` }));
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setAsanaMsg({ t: j.detail || okMsg, ok: true });
      if (typeof j.project === "string" && j.project) setAsanaProject(j.project);
    } catch (e) { setAsanaMsg({ t: e instanceof Error ? e.message : "저장 실패", ok: false }); }
    finally { setBusy(""); }
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설정 · 아사나 연동</h1>
        </div>
      </header>

      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">아사나(Asana) 연동</span></div>
        <p className="sm-muted" style={{ fontSize: 15, marginBottom: 12 }}>
          VOC 목록/상세에서 <strong>→ 아사나</strong> 버튼으로 해당 VOC를 아사나 프로젝트의 <strong>업무(task)</strong>로 등록합니다.
          PAT와 프로젝트가 모두 저장되면 VOC 화면에 버튼이 나타납니다.
          토큰 발급: 아사나 <strong>내 설정 → 앱 → 개발자 앱 관리 → 개인 액세스 토큰(PAT) 만들기</strong>.
        </p>

        <div className="sm-col" style={{ gap: 6, marginBottom: 14 }}>
          <span className="b2b-field-label">1) 개인 액세스 토큰(PAT) · 현재 {loading ? "확인 중…" : hasAsanaPat ? <strong style={{ color: "var(--sm-success)" }}>저장됨</strong> : <strong style={{ color: "var(--sm-warning)" }}>미설정</strong>}</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="b2b-input" type="password" value={asanaPat} onChange={(e) => setAsanaPat(e.target.value)} placeholder={hasAsanaPat ? "새 토큰으로 변경(비우고 저장 시 해제)" : "아사나에서 발급한 PAT 붙여넣기"} style={{ flex: 1, minWidth: 240 }} />
            <button className="b2b-btn-primary" onClick={async () => { await saveAsana({ pat: asanaPat }, asanaPat.trim() ? "PAT 저장됨" : "PAT 해제됨", "asanapat"); setHasAsanaPat(!!asanaPat.trim()); setAsanaPat(""); }} disabled={busy === "asanapat"}>{busy === "asanapat" ? "저장 중…" : "저장"}</button>
          </div>
        </div>

        <div className="sm-col" style={{ gap: 6, marginBottom: 14 }}>
          <span className="b2b-field-label">2) 프로젝트 (URL 또는 gid)</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="b2b-input" value={asanaProject} onChange={(e) => setAsanaProject(e.target.value)} placeholder="아사나에서 프로젝트를 연 상태의 주소를 그대로 붙여넣기" style={{ flex: 1, minWidth: 240 }} />
            <button className="b2b-btn-secondary" onClick={() => saveAsana({ project: asanaProject }, "프로젝트 저장됨", "asanaproj")} disabled={busy === "asanaproj"}>{busy === "asanaproj" ? "저장 중…" : "저장"}</button>
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>URL을 넣으면 프로젝트 번호(gid)만 추려 저장합니다. 등록되는 업무는 VOC 상태와 무관하게 항상 &apos;개선요청&apos; 섹션에 들어갑니다(이후 상태 관리는 아사나에서).</span>
        </div>

        <div className="sm-col" style={{ gap: 6, marginBottom: 14 }}>
          <span className="b2b-field-label">3) 기본 담당자 (이메일 · 선택)</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="b2b-input" type="email" value={asanaAssignee} onChange={(e) => setAsanaAssignee(e.target.value)} placeholder="아사나 워크스페이스 멤버 이메일 (비우면 미지정)" style={{ flex: 1, minWidth: 240 }} />
            <button className="b2b-btn-secondary" onClick={() => saveAsana({ assignee: asanaAssignee }, asanaAssignee.trim() ? "기본 담당자 저장됨" : "기본 담당자 해제됨", "asanaassignee")} disabled={busy === "asanaassignee"}>{busy === "asanaassignee" ? "저장 중…" : "저장"}</button>
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>등록되는 업무의 담당자로 지정됩니다. 멤버가 아니면 담당자 없이 등록되고 안내가 표시됩니다.</span>
        </div>

        <div className="sm-row" style={{ gap: 8 }}>
          <button className="b2b-btn-secondary" onClick={() => saveAsana({ test: true }, "연결 OK", "asanatest")} disabled={busy === "asanatest"}>{busy === "asanatest" ? "확인 중…" : "연결 테스트"}</button>
          <span className="sm-faint" style={{ fontSize: 12, alignSelf: "center" }}>저장된 토큰으로 내 계정과 프로젝트 접근을 확인합니다.</span>
        </div>
        {asanaMsg && <div className={asanaMsg.ok ? "sm-success" : "b2b-error"} style={{ marginTop: 10 }}>{asanaMsg.t}</div>}
      </section>

      {/* OKR 1:1 연동 — 회의 정리의 [OKR 업로드]가 쓰는 목적지. 위 PAT 를 그대로 사용한다 */}
      <section className="b2b-card" style={{ marginTop: 28 }}>
        <div className="b2b-card-head">
          <span className="b2b-card-title">OKR 1:1 연동</span>
          <button className="b2b-btn-primary" onClick={saveOkr} disabled={okrBusy}>{okrBusy ? "저장 중…" : "저장"}</button>
        </div>
        <p className="sm-muted" style={{ fontSize: 15, marginBottom: 12 }}>
          회의 정리에서 각자 업로드한 1:1 회의 결과가 들어가는 곳입니다. 공개 요약·OKR 할 일은 <strong>공통 OKR 관리 프로젝트</strong>로,
          비공개 요약·개인 할 일은 <strong>각자의 개인 소통방</strong>(비공개, 대표+당사자)으로 갑니다.
          할 일에는 <strong>당사자가 담당자로 지정</strong>되므로 아사나 계정 이메일을 함께 넣어야 마감 알림이 갑니다.
          모든 프로젝트에 <strong>PAT 소유자(대표)가 멤버</strong>여야 합니다.
        </p>
        {okrMsg && <div className={okrMsg.ok ? "sm-success" : "b2b-error"} style={{ marginBottom: 10 }}>{okrMsg.t}</div>}

        <div className="sm-col" style={{ gap: 6, marginBottom: 14 }}>
          <span className="b2b-field-label">공통 OKR 관리 프로젝트 (URL 또는 gid)</span>
          <input className="b2b-input" value={okrProject} onChange={(e) => setOkrProject(e.target.value)} placeholder="아사나에서 OKR 관리 프로젝트를 연 상태의 주소 붙여넣기" style={{ maxWidth: 560 }} />
        </div>

        <div className="sm-col" style={{ gap: 6 }}>
          <span className="b2b-field-label">개인 소통방·담당자 매핑 <span className="sm-faint" style={{ fontWeight: 400 }}>· 이름은 업무도우미 로그인 사용자명과 정확히 일치해야 합니다</span></span>
          {okrRows.map((r, i) => (
            <div key={i} className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
              <input className="b2b-input" value={r.name} onChange={(e) => setOkrRows((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="사용자명 (예: 현석)" style={{ width: 140 }} />
              <input className="b2b-input" value={r.project} onChange={(e) => setOkrRows((p) => p.map((x, j) => j === i ? { ...x, project: e.target.value } : x))} placeholder="개인 소통방 프로젝트 URL 또는 gid" style={{ flex: 1, minWidth: 240 }} />
              <input className="b2b-input" type="email" value={r.email} onChange={(e) => setOkrRows((p) => p.map((x, j) => j === i ? { ...x, email: e.target.value } : x))} placeholder="아사나 계정 이메일" style={{ width: 220 }} />
              <button type="button" className="b2b-icon-btn is-danger" aria-label="행 삭제" onClick={() => setOkrRows((p) => p.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button type="button" className="b2b-btn-secondary" onClick={() => setOkrRows((p) => [...p, { name: "", project: "", email: "" }])}>+ 사용자 추가</button></div>
          <span className="sm-faint" style={{ fontSize: 12 }}>저장하면 URL에서 프로젝트 번호(gid)만 추려 보관합니다. 빈 행은 무시됩니다. 이메일이 비어 있으면 할 일이 담당자 없이 등록되어 아사나가 알림을 보내지 않습니다.</span>
        </div>

        <div className="sm-row" style={{ gap: 8, marginTop: 14, alignItems: "center" }}>
          <button type="button" className="b2b-btn-secondary" onClick={testOkr} disabled={okrBusy}>{okrBusy ? "확인 중…" : "연동 점검"}</button>
          <span className="sm-faint" style={{ fontSize: 12 }}>저장된 설정으로 공통 프로젝트와 개인방 전부의 접근을 확인합니다.</span>
        </div>
        {okrTest.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.8 }}>
            {okrTest.map((l, i) => (
              <div key={i} className={/실패|미설정|비어|없어/.test(l) ? "b2b-error" : "sm-success"} style={{ padding: "2px 10px", marginBottom: 4 }}>{l}</div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
