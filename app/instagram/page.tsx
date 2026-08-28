"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// 인스타 자동 DM — 특정 게시물에 댓글이 달리면(선택: 키워드) 그 작성자에게 1회 DM(Private Reply).
//  계정 3개 운영 · 규칙별 켜고 끄는 일정(start/end) · 브랜드링크(link.seamonster.kr)면 클릭수 자동 집계.

type Account = { igUserId: string; username: string; tokenMasked: string; updatedAt: string };
type AccountsRes = { ok: boolean; configured: { appSecret: boolean; verifyToken: boolean }; webhookUrl: string; accounts: Account[]; error?: string };
type Rule = {
  id: string; ig_user_id: string; media_id: string; media_permalink: string; media_caption: string;
  keyword: string; message: string; link: string; active: boolean;
  start_at: string | null; end_at: string | null; created_at: string;
  sent: number; failed: number; clicks: number | null;
};
type Media = { id: string; caption: string; permalink: string; thumb: string; timestamp: string };
type Log = { id: string; ig_user_id: string; commenter_username: string; comment_text: string; status: string; error: string; created_at: string; rule_caption: string };

type RuleDraft = {
  id?: string; ig_user_id: string; media_id: string; media_permalink: string; media_caption: string;
  keyword: string; message: string; link: string; active: boolean; start_local: string; end_local: string;
};
const EMPTY_DRAFT: RuleDraft = { ig_user_id: "", media_id: "", media_permalink: "", media_caption: "", keyword: "", message: "", link: "", active: true, start_local: "", end_local: "" };

// KST 표시·입력 변환 — datetime-local(분 단위) ↔ ISO
const isoToLocal = (iso: string | null) => {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t + 9 * 3600e3).toISOString().slice(0, 16);
};
const localToIso = (local: string) => (local ? `${local}:00+09:00` : null);
const fmtKst = (iso: string | null) => (iso ? isoToLocal(iso).replace("T", " ") : "");

export default function InstagramDmPage() {
  const [info, setInfo] = useState<AccountsRes | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [tokenInput, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);

  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [media, setMedia] = useState<Media[] | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [a, r, l] = await Promise.all([
        (await fetch("/api/instagram/accounts", { cache: "no-store" })).json(),
        (await fetch("/api/instagram/rules", { cache: "no-store" })).json(),
        (await fetch("/api/instagram/logs", { cache: "no-store" })).json(),
      ]);
      if (!a.ok) throw new Error(a.error || "계정 조회 실패");
      setInfo(a as AccountsRes);
      if (r.ok) setRules(r.rules || []); else if (!/does not exist|찾을 수 없|relation/i.test(r.error || "")) setError(r.error || "");
      if (l.ok) setLogs(l.logs || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const accName = useMemo(() => {
    const m = Object.fromEntries((info?.accounts || []).map((a) => [a.igUserId, a.username]));
    return (id: string) => m[id] || id;
  }, [info]);

  async function addToken() {
    if (!tokenInput.trim()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const j = await (await fetch("/api/instagram/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tokenInput.trim() }) })).json();
      if (!j.ok) throw new Error(j.error);
      setNotice(`@${j.added} 연결됨 — '웹훅 구독'까지 눌러야 댓글 알림이 옵니다.`);
      setTokenInput("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "등록 실패"); }
    setBusy(false);
  }
  async function subscribe(igUserId: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const j = await (await fetch("/api/instagram/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscribe: igUserId }) })).json();
      if (!j.ok) throw new Error(j.error);
      setNotice(`@${j.subscribed} 웹훅 구독 완료 — 이제 이 계정 댓글이 실시간으로 들어옵니다.`);
    } catch (e) { setError(e instanceof Error ? e.message : "구독 실패"); }
    setBusy(false);
  }
  async function removeAccount(a: Account) {
    if (!confirm(`@${a.username} 연결을 해제할까요? 이 계정의 규칙은 남지만 발송이 멈춥니다.`)) return;
    await fetch(`/api/instagram/accounts?id=${encodeURIComponent(a.igUserId)}`, { method: "DELETE" });
    load();
  }

  function openNew() {
    const first = info?.accounts[0]?.igUserId || "";
    setDraft({ ...EMPTY_DRAFT, ig_user_id: first });
    setMedia(null);
  }
  function openEdit(r: Rule) {
    setDraft({
      id: r.id, ig_user_id: r.ig_user_id, media_id: r.media_id, media_permalink: r.media_permalink, media_caption: r.media_caption,
      keyword: r.keyword, message: r.message, link: r.link, active: r.active,
      start_local: isoToLocal(r.start_at), end_local: isoToLocal(r.end_at),
    });
    setMedia(null);
  }
  async function loadMedia(igUserId: string) {
    if (!igUserId) return;
    setMediaLoading(true); setError("");
    try {
      const j = await (await fetch(`/api/instagram/media?account=${encodeURIComponent(igUserId)}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error);
      setMedia(j.media || []);
    } catch (e) { setError(e instanceof Error ? e.message : "게시물 조회 실패"); }
    setMediaLoading(false);
  }
  async function saveRule() {
    if (!draft) return;
    setSaving(true); setError("");
    try {
      const body = {
        id: draft.id, ig_user_id: draft.ig_user_id, media_id: draft.media_id,
        media_permalink: draft.media_permalink, media_caption: draft.media_caption,
        keyword: draft.keyword, message: draft.message, link: draft.link, active: draft.active,
        start_at: localToIso(draft.start_local), end_at: localToIso(draft.end_local),
      };
      const j = await (await fetch("/api/instagram/rules", { method: draft.id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
      if (!j.ok) throw new Error(j.error);
      setDraft(null);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }
  async function toggleRule(r: Rule) {
    const j = await (await fetch("/api/instagram/rules", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...r, active: !r.active }) })).json();
    if (j.ok) setRules((prev) => prev.map((x) => (x.id === r.id ? { ...x, active: !r.active } : x)));
  }
  async function removeRule(r: Rule) {
    if (!confirm(`이 규칙을 삭제할까요?\n${r.media_caption || r.media_permalink}`)) return;
    await fetch(`/api/instagram/rules?id=${encodeURIComponent(r.id)}`, { method: "DELETE" });
    load();
  }

  const ruleState = (r: Rule): { label: string; cls: string } => {
    if (!r.active) return { label: "꺼짐", cls: "is-off" };
    const now = Date.now();
    if (r.start_at && now < Date.parse(r.start_at)) return { label: "예약", cls: "is-wait" };
    if (r.end_at && now > Date.parse(r.end_at)) return { label: "종료", cls: "is-off" };
    return { label: "발송 중", cls: "is-on" };
  };

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">인스타 자동 DM</h1>
          <p className="b2b-page-subtitle">이벤트 게시물에 댓글이 달리면 작성자에게 자동으로 DM 1회를 보냅니다. 계정별·게시물별 규칙과 켜고 끄는 일정으로 운영합니다.</p>
        </div>
        <div className="b2b-page-actions sm-row sm-gap-2">
          <button className="b2b-btn-primary" onClick={openNew} disabled={(info?.accounts.length || 0) === 0}>+ 규칙 추가</button>
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "..." : "새로고침"}</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {notice && <div className="ig-notice">{notice}</div>}

      {/* 연결 상태 */}
      <section className="b2b-card ig-setup">
        <div className="b2b-card-head"><span className="b2b-card-title">계정 연결</span></div>
        {info && (!info.configured.appSecret || !info.configured.verifyToken) && (
          <p className="ig-warn">서버 연동 준비 중 — 연동이 완료되면 자동으로 동작합니다. 관리자에게 문의하세요.</p>
        )}
        <div className="ig-webhook-row">
          <span className="ig-webhook-label">웹훅 URL</span>
          <code className="ig-webhook-url">{info?.webhookUrl || "..."}</code>
          <button className="b2b-btn-secondary ig-btn-sm" onClick={() => { navigator.clipboard?.writeText(info?.webhookUrl || ""); setNotice("웹훅 URL 복사됨 — 메타 앱 대시보드에 붙여넣으세요."); }}>복사</button>
        </div>
        <div className="ig-accounts">
          {(info?.accounts || []).map((a) => (
            <div key={a.igUserId} className="ig-account">
              <span className="ig-account-name">@{a.username}</span>
              <span className="sm-faint ig-account-meta">{a.tokenMasked} · 토큰 {fmtKst(a.updatedAt).slice(0, 10)}</span>
              <button className="b2b-btn-secondary ig-btn-sm" onClick={() => subscribe(a.igUserId)} disabled={busy}>웹훅 구독</button>
              <button className="b2b-icon-btn" aria-label="연결 해제" onClick={() => removeAccount(a)}>✕</button>
            </div>
          ))}
          {(info?.accounts.length || 0) === 0 && <p className="sm-faint">연결된 계정이 없습니다. 아래에 토큰을 붙여넣어 시작하세요. (3개 계정 각각 등록)</p>}
        </div>
        <div className="ig-token-row">
          <input className="b2b-input ig-token-input" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)}
            placeholder="인스타그램 로그인 장기 토큰 붙여넣기 (계정별)" spellCheck={false} />
          <button className="b2b-btn-secondary" onClick={addToken} disabled={busy || !tokenInput.trim()}>{busy ? "..." : "계정 연결"}</button>
        </div>
      </section>

      {/* 규칙 */}
      <section className="b2b-card ig-rules-card">
        <div className="b2b-card-head"><span className="b2b-card-title">규칙</span><span className="sm-faint ig-head-note">게시물 1개 = 규칙 1개 · 발송/클릭은 실시간 집계</span></div>
        {rules.length === 0 ? (
          <p className="sm-faint">규칙이 없습니다. 계정을 연결한 뒤 '+ 규칙 추가'로 시작하세요.</p>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr>
                <th>상태</th><th>계정</th><th className="ig-col-media">게시물</th><th>키워드</th><th className="ig-col-sched">일정</th>
                <th className="num">발송</th><th className="num">클릭</th><th className="ig-col-actions"></th>
              </tr></thead>
              <tbody>
                {rules.map((r) => {
                  const st = ruleState(r);
                  return (
                    <tr key={r.id}>
                      <td><span className={`ig-state ${st.cls}`}>{st.label}</span></td>
                      <td className="ig-cell-nowrap">@{accName(r.ig_user_id)}</td>
                      <td className="ig-col-media">
                        {r.media_permalink
                          ? <a href={r.media_permalink} target="_blank" rel="noreferrer" className="ig-media-link">{r.media_caption || r.media_id}</a>
                          : (r.media_caption || r.media_id)}
                      </td>
                      <td>{r.keyword || <span className="sm-faint">모든 댓글</span>}</td>
                      <td className="ig-col-sched">
                        {r.start_at || r.end_at
                          ? <span className="ig-sched">{fmtKst(r.start_at) || "즉시"} ~ {fmtKst(r.end_at) || "계속"}</span>
                          : <span className="sm-faint">상시</span>}
                      </td>
                      <td className="num b2b-money">{r.sent}{r.failed > 0 && <span className="ig-failed" title="실패">+{r.failed}실패</span>}</td>
                      <td className="num b2b-money">{r.clicks == null ? <span className="sm-faint" title="브랜드링크(link.seamonster.kr)를 쓰면 클릭이 집계됩니다">-</span> : r.clicks}</td>
                      <td className="actions ig-cell-nowrap">
                        <button className="b2b-btn-secondary ig-btn-sm" onClick={() => toggleRule(r)}>{r.active ? "끄기" : "켜기"}</button>
                        <button className="b2b-btn-secondary ig-btn-sm" onClick={() => openEdit(r)}>편집</button>
                        <button className="b2b-icon-btn" aria-label="삭제" onClick={() => removeRule(r)}>✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 발송 로그 */}
      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">최근 발송</span><span className="sm-faint ig-head-note">최근 100건</span></div>
        {logs.length === 0 ? <p className="sm-faint">아직 발송 기록이 없습니다.</p> : (
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr><th>시각</th><th>계정</th><th>게시물</th><th>댓글 작성자</th><th className="ig-col-media">댓글</th><th>상태</th></tr></thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="ig-cell-nowrap">{fmtKst(l.created_at)}</td>
                    <td className="ig-cell-nowrap">@{accName(l.ig_user_id)}</td>
                    <td className="ig-col-media">{l.rule_caption}</td>
                    <td className="ig-cell-nowrap">@{l.commenter_username}</td>
                    <td className="ig-col-media sm-faint">{l.comment_text}</td>
                    <td>{l.status === "sent" ? <span className="ig-state is-on">발송</span> : <span className="ig-state is-fail" title={l.error}>실패</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 규칙 편집 모달 */}
      {draft && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal ig-modal" onClick={(e) => e.stopPropagation()}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">{draft.id ? "규칙 수정" : "새 규칙"}</h2>
              <button className="b2b-modal-close" onClick={() => setDraft(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">계정</span>
                  <select className="b2b-select" value={draft.ig_user_id} onChange={(e) => { setDraft({ ...draft, ig_user_id: e.target.value, media_id: "", media_caption: "", media_permalink: "" }); setMedia(null); }}>
                    {(info?.accounts || []).map((a) => <option key={a.igUserId} value={a.igUserId}>@{a.username}</option>)}
                  </select></label>
                <div className="b2b-field ig-media-load">
                  <span className="b2b-field-label">게시물</span>
                  <button type="button" className="b2b-btn-secondary" onClick={() => loadMedia(draft.ig_user_id)} disabled={mediaLoading || !draft.ig_user_id}>
                    {mediaLoading ? "불러오는 중..." : media ? "다시 불러오기" : "최근 게시물 불러오기"}
                  </button>
                </div>
              </div>

              {draft.media_id && (
                <p className="ig-picked">선택됨: {draft.media_caption || draft.media_id} {draft.media_permalink && <a href={draft.media_permalink} target="_blank" rel="noreferrer">열기 ↗</a>}</p>
              )}
              {media && (
                <div className="ig-media-grid">
                  {media.map((m) => (
                    <button type="button" key={m.id} className={`ig-media-item${draft.media_id === m.id ? " is-picked" : ""}`}
                      onClick={() => setDraft({ ...draft, media_id: m.id, media_caption: m.caption, media_permalink: m.permalink })}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {m.thumb ? <img src={m.thumb} alt="" className="ig-media-thumb" /> : <span className="ig-media-thumb ig-media-noimg" />}
                      <span className="ig-media-cap">{m.caption || m.id}</span>
                    </button>
                  ))}
                  {media.length === 0 && <p className="sm-faint">게시물이 없습니다.</p>}
                </div>
              )}

              <label className="b2b-field"><span className="b2b-field-label">키워드 (선택, 쉼표 구분)</span>
                <input className="b2b-input" value={draft.keyword} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })} placeholder="비우면 모든 댓글에 발송 · 예: 신청, 참여" /></label>
              <label className="b2b-field"><span className="b2b-field-label">보낼 메시지</span>
                <textarea className="b2b-textarea" rows={4} value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })}
                  placeholder={"{닉네임}님, 참여 감사합니다! 이벤트 안내는 여기서 확인하세요 → https://link.seamonster.kr/이벤트"} />
                <span className="sm-faint ig-hint">{"{닉네임}"} 은 댓글 작성자 이름으로 바뀝니다. 링크는 메시지 안에 직접 포함하세요.</span></label>
              <label className="b2b-field"><span className="b2b-field-label">링크 (클릭 집계용)</span>
                <input className="b2b-input" value={draft.link} onChange={(e) => setDraft({ ...draft, link: e.target.value })} placeholder="https://link.seamonster.kr/이벤트 — 브랜드링크면 클릭수가 표에 집계됩니다" spellCheck={false} />
                <span className="sm-faint ig-hint">메시지에 넣은 링크와 같은 주소를 적어두면 규칙 표에서 발송 대비 클릭을 볼 수 있습니다. QR코드/브랜드링크 메뉴에서 만들 수 있어요.</span></label>

              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">켜는 시각 (비우면 즉시)</span>
                  <input type="datetime-local" className="b2b-input" value={draft.start_local} onChange={(e) => setDraft({ ...draft, start_local: e.target.value })} /></label>
                <label className="b2b-field"><span className="b2b-field-label">끄는 시각 (비우면 계속)</span>
                  <input type="datetime-local" className="b2b-input" value={draft.end_local} onChange={(e) => setDraft({ ...draft, end_local: e.target.value })} /></label>
              </div>
              <label className="sm-row sm-gap-2 ig-active-check">
                <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> 규칙 활성 (끄면 일정과 무관하게 발송 정지)
              </label>
            </div>
            <div className="b2b-modal-foot">
              <div />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setDraft(null)}>취소</button>
                <button className="b2b-btn-primary" onClick={saveRule} disabled={saving || !draft.media_id || !draft.message.trim()}>{saving ? "저장 중..." : "저장"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
