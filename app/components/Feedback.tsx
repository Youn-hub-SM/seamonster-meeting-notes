"use client";

// 결과 알림 공용 — 토스트 1종 + 되돌리기 토스트 + 확인 모달(브라우저 alert/confirm 대체). 2026-10-14 UX 2차 B1·B2·B3.
//  원칙(docs/ux-affordance-plan.md §1-4): 결과는 같은 자리(화면 아래 가운데), 같은 모양으로.
//  - toast.success("저장했습니다")                       : 4초 뒤 사라짐, 닫기 버튼
//  - toast.error("저장 실패: ...")                       : 7초, 빨강 테두리. 폼 안 오류는 기존 .b2b-error 배너를 쓰고, 배너 둘 곳이 없는 작업(표 안 버튼 등)에만
//  - toast.undo("입금완료로 바꿨습니다", () => 되돌리기) : 5초 안에 [되돌리기] 누르면 콜백 실행. 저위험 상태 변경은 확인창 없이 바로 반영 + 이것
//  - await confirm({ title, body, action, danger })      : 파괴적 행동(삭제·취소·되돌릴 수 없는 적용)에만. title=무엇을, body=결과, action=동사형 버튼 글자('발주 삭제')
//  사용: const toast = useToast(); const confirm = useConfirm();  (AppShell 이 <FeedbackProvider> 를 감싼다 — /factory 는 자체 셸이라 제외)
//  모양은 globals.css .sm-toast* / 모달은 b2b.css 의 .b2b-modal* 재사용.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type ToastKind = "success" | "error" | "undo";
type ToastItem = { id: number; kind: ToastKind; text: string; onUndo?: () => void | Promise<void>; ttl: number };

export type ConfirmOptions = {
  /** 무엇을 — 모달 제목(예: "발주 B2B-0912 삭제") */
  title: string;
  /** 결과 — 본문 한두 문장(예: "발주와 입금 기록이 함께 지워집니다. 되돌릴 수 없습니다."). 생략 가능 */
  body?: ReactNode;
  /** 1차 버튼 글자 — 동사형(예: "발주 삭제", "취소 처리"). 기본 "확인" 은 쓰지 않는다 */
  action: string;
  /** 파괴적 행동이면 true(빨간 테두리 버튼). 기본 true */
  danger?: boolean;
  /** 2차 버튼 글자. 기본 "그만두기" */
  cancel?: string;
};

type Ctx = {
  push: (kind: ToastKind, text: string, onUndo?: () => void | Promise<void>) => void;
  confirm: (o: ConfirmOptions) => Promise<boolean>;
};

const FeedbackCtx = createContext<Ctx | null>(null);

const TTL: Record<ToastKind, number> = { success: 4000, error: 7000, undo: 5000 };

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setToasts((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, text: string, onUndo?: () => void | Promise<void>) => {
    const id = ++seq.current;
    const ttl = TTL[kind];
    // 한 번에 3개까지 — 더 오면 가장 오래된 것부터 지운다(쌓여서 화면을 가리지 않게)
    setToasts((xs) => [...xs.slice(-2), { id, kind, text, onUndo, ttl }]);
    timers.current.set(id, setTimeout(() => dismiss(id), ttl));
  }, [dismiss]);

  // 확인 모달 — 한 번에 하나. Promise 로 답을 돌려주어 `if (!(await confirm({...}))) return;` 꼴로 쓴다.
  const [pending, setPending] = useState<{ o: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setPending((cur) => { cur?.resolve(false); return { o, resolve }; });
  }), []);
  const answer = useCallback((v: boolean) => { setPending((cur) => { cur?.resolve(v); return null; }); }, []);

  // Esc = 그만두기. 열릴 때 1차 버튼이 아니라 2차(그만두기)에 초점 — 엔터 연타로 파괴적 행동이 나가지 않게
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!pending) return;
    cancelRef.current?.focus();
    // 캡처 단계에서 받고 전파를 끊는다 — 부모 모달의 useEscClose(window 버블)가 같은 Esc 로 같이 닫히지 않게(2026-10-14 검토)
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); answer(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, answer]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const ctx = useMemo<Ctx>(() => ({ push, confirm }), [push, confirm]);

  return (
    <FeedbackCtx.Provider value={ctx}>
      {children}
      {/* 토스트 — 화면 아래 가운데. 성공은 aria-live polite, 오류는 assertive */}
      <div className="sm-toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`sm-toast is-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
            <span className="sm-toast-text">{t.text}</span>
            {t.kind === "undo" && t.onUndo && (
              <button type="button" className="sm-toast-undo" onClick={async () => { dismiss(t.id); await t.onUndo?.(); }}>되돌리기</button>
            )}
            <button type="button" className="sm-toast-close" aria-label="닫기" title="닫기" onClick={() => dismiss(t.id)}>✕</button>
          </div>
        ))}
      </div>
      {pending && (
        <div className="b2b-modal-backdrop" onClick={() => answer(false)}>
          <div className="b2b-modal sm-confirm" role="alertdialog" aria-modal="true" aria-labelledby="sm-confirm-title" onClick={(e) => e.stopPropagation()}>
            <div className="b2b-modal-head">
              <span className="b2b-modal-title" id="sm-confirm-title">{pending.o.title}</span>
              <button type="button" className="b2b-modal-close" aria-label="닫기" title="닫기" onClick={() => answer(false)}>✕</button>
            </div>
            {pending.o.body && <div className="b2b-modal-body">{pending.o.body}</div>}
            <div className="b2b-modal-foot">
              <div className="b2b-modal-foot-right">
                <button ref={cancelRef} type="button" className="b2b-btn-secondary" onClick={() => answer(false)}>{pending.o.cancel ?? "그만두기"}</button>
                <button type="button" className={pending.o.danger === false ? "b2b-btn-primary" : "b2b-btn-danger"} onClick={() => answer(true)}>{pending.o.action}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </FeedbackCtx.Provider>
  );
}

function useCtx(): Ctx {
  const c = useContext(FeedbackCtx);
  if (!c) throw new Error("FeedbackProvider 밖에서 useToast/useConfirm 을 불렀습니다 — AppShell 안의 화면에서만 쓸 수 있습니다.");
  return c;
}

/** 토스트 — success(text) · error(text) · undo(text, 되돌리기 콜백) */
export function useToast() {
  const { push } = useCtx();
  return useMemo(() => ({
    success: (text: string) => push("success", text),
    error: (text: string) => push("error", text),
    undo: (text: string, onUndo: () => void | Promise<void>) => push("undo", text, onUndo),
  }), [push]);
}

/** 확인 모달 — `if (!(await confirm({ title, body, action }))) return;` */
export function useConfirm() {
  return useCtx().confirm;
}
