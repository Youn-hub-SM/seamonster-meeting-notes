"use client";

import dynamic from "next/dynamic";

// 파렛트 적재 시뮬레이터 — three.js 는 번들이 커서 이 페이지에서만 클라이언트 로드한다.
const PalletSim = dynamic(() => import("./PalletSim"), {
  ssr: false,
  loading: () => <div className="b2b-loading">3D 화면 불러오는 중...</div>,
});

export default function PalletPage() {
  return <PalletSim />;
}
