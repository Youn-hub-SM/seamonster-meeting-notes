"use client";

// 직원 확인 링크 — 인사기록카드 안의 한 칸. 직원에게 줄 주소를 만들고, 복사하고, 다시 만들고, 끊는다.
//  직원은 그 주소를 열고 주민등록번호로 본인 확인을 한 뒤 자기 급여명세서·연차·근태만 본다(/me/<토큰>).

import { useEffect, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { HrApiError, errText, hrApi } from "../../api";

type LinkInfo = { token: string; active: boolean; blocked: boolean; version: number; created_at: string; updated_at: string; last_opened_at: string | null };
type Action = "create" | "regenerate" | "revoke";

const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
  : "");

export default function LinkField({ employeeId, name, hasRrn }: { employeeId: string; name: string; hasRrn: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [link, setLink] = useState<LinkInfo | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "pending" | "error">("loading");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    hrApi<{ link: LinkInfo | null }>(`/api/hr/links?employee=${employeeId}`)
      .then((j) => { if (alive) { setLink(j.link); setState("ready"); } })
      .catch((err) => {
        if (!alive || (err instanceof HrApiError && err.status === 401)) return;
        setNote(errText(err, "직원 확인 링크를 불러오지 못했습니다."));
        setState(err instanceof HrApiError && err.pending ? "pending" : "error");
      });
    return () => { alive = false; };
  }, [employeeId]);

  const url = link?.active ? `${window.location.origin}/me/${link.token}` : "";

  async function run(action: Action, done: string) {
    setBusy(true);
    try {
      const j = await hrApi<{ link: LinkInfo | null }>("/api/hr/links", "POST", { employee_id: employeeId, action });
      setLink(j.link);
      toast.success(done);
    } catch (err) { toast.error(errText(err, "직원 확인 링크를 저장하지 못했습니다.")); }
    setBusy(false);
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("링크를 복사했습니다");
    } catch { toast.error("복사하지 못했습니다. 주소를 직접 선택해 복사하세요."); }
  }
  async function regenerate() {
    const ok = await confirm({ title: `${name} 링크 다시 만들기`, body: "지금 주소는 더 열리지 않습니다. 새 주소를 직원에게 다시 전해야 합니다.", action: "링크 다시 만들기" });
    if (ok) run("regenerate", "링크를 다시 만들었습니다");
  }
  async function revoke() {
    const ok = await confirm({ title: `${name} 링크 끊기`, body: "이 직원은 더 이상 주소로 급여명세서·연차·근태를 볼 수 없습니다.", action: "링크 끊기" });
    if (ok) run("revoke", "링크를 끊었습니다");
  }

  return (
    <section className="hr-card-sec hr-noprint">
      <h2>직원 확인 링크</h2>
      <div className="hr-link-row">
        {state === "loading" ? <span className="hr-link-url">불러오는 중...</span>
          : state === "pending" ? <div className="sm-warn" style={{ flex: 1 }}>{note}</div>
          : state === "error" ? <div className="b2b-error" style={{ flex: 1 }} role="alert">{note}</div>
          : link?.active ? (
            <>
              {link.blocked && <div className="sm-warn" style={{ flexBasis: "100%" }}>본인 확인을 20번 틀려 잠긴 링크입니다. [링크 다시 만들기]를 눌러 새 주소를 직원에게 주세요.</div>}
              <span className="hr-link-url">{url}</span>
              <button type="button" className="b2b-btn-primary" onClick={copy}>링크 복사</button>
              <button type="button" className="b2b-btn-secondary" onClick={regenerate} disabled={busy}>링크 다시 만들기</button>
              <button type="button" className="b2b-btn-secondary" onClick={revoke} disabled={busy}>링크 끊기</button>
              <span className="hr-link-url" style={{ flexBasis: "100%" }}>
                {link.last_opened_at ? `마지막 본인 확인 ${when(link.last_opened_at)}` : "아직 연 적이 없습니다"} · 만든 때 {when(link.updated_at || link.created_at)}
              </span>
            </>
          ) : (
            <>
              <span className="hr-link-url">
                {!hasRrn ? "주민등록번호가 없어 본인 확인을 할 수 없습니다. [정보 수정]에서 번호를 먼저 넣으세요."
                  : link ? "끊은 링크입니다." : "만든 링크가 없습니다."}
              </span>
              <button type="button" className="b2b-btn-primary" onClick={() => run("create", "링크를 만들었습니다")} disabled={busy || !hasRrn}>링크 만들기</button>
            </>
          )}
      </div>
    </section>
  );
}
