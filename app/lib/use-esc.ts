"use client";

import { useEffect } from "react";

// 모달 공용 Esc 닫기(2026-08-28) — 컴포넌트형 모달은 이 훅 한 줄로 통일.
//  backdrop 클릭 닫기와 별개로 키보드만 담당. busy(저장 중)면 무시해 실수 이탈을 막는다.
export function useEscClose(onClose: () => void, busy = false) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, busy]);
}
