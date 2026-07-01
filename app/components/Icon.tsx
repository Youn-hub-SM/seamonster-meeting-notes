// 사이드바용 라인 아이콘 세트. stroke=currentColor 라 부모 링크 색(기본/hover/활성 오렌지)을 그대로 따라감.
// 새 메뉴 아이콘이 필요하면 여기에 key 하나만 추가하고 nav.ts 의 icon 값으로 지정.
import type { ReactNode } from "react";

export type IconName =
  | "home" | "truck" | "fish" | "trend" | "factory" | "box" | "bulb" | "bars"
  | "receipt" | "tag" | "link" | "pen" | "chat" | "megaphone" | "note" | "user" | "gear" | "qrcode" | "book";

const PATHS: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10.5V20h13v-9.5" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  truck: (
    <>
      <path d="M1.5 6h12v10.5H1.5z" />
      <path d="M13.5 9h3.7l3.3 3.3v4.2h-7z" />
      <circle cx="6" cy="18.4" r="1.7" />
      <circle cx="17.4" cy="18.4" r="1.7" />
    </>
  ),
  fish: (
    <>
      <path d="M7 12c0-2.9 3.3-5.2 7.4-5.2 3.3 0 6.1 1.9 7.6 5.2-1.5 3.3-4.3 5.2-7.6 5.2C10.3 17.2 7 14.9 7 12z" />
      <path d="M7 12 2.5 8v8z" />
      <circle cx="16.6" cy="10.4" r="0.7" />
    </>
  ),
  trend: (
    <>
      <polyline points="3 16.5 9 10.5 13 14 21 6" />
      <polyline points="15.5 6 21 6 21 11.5" />
    </>
  ),
  factory: (
    <>
      <path d="M3 21V11l5.5 3.2V11l5.5 3.2V7.5h6.5V21Z" />
      <path d="M17 7.5V4.5h2.2V7.5" />
      <path d="M2 21h20" />
    </>
  ),
  box: (
    <>
      <path d="M12 2.5l8.5 4.7v9.6L12 21.5l-8.5-4.7V7.2z" />
      <path d="M3.7 7.3 12 12l8.3-4.7" />
      <path d="M12 12v9.5" />
      <path d="M7.6 4.6 16 9.3" />
    </>
  ),
  bulb: (
    <>
      <path d="M12 3a6 6 0 0 0-3.8 10.6c.8.7 1.3 1.4 1.3 2.4h5c0-1 .5-1.7 1.3-2.4A6 6 0 0 0 12 3z" />
      <path d="M9.5 18.5h5" />
      <path d="M10.5 21h3" />
    </>
  ),
  bars: (
    <>
      <path d="M3.5 20.5h17" />
      <path d="M7 20.5V13" />
      <path d="M12 20.5V7" />
      <path d="M17 20.5v-5" />
    </>
  ),
  receipt: (
    <>
      <path d="M5.5 3h13v18l-2.2-1.4-2.2 1.4-2.2-1.4-2.1 1.4-2.1-1.4L5.5 21z" />
      <path d="M8.5 8h7M8.5 12h7M8.5 16h4.5" />
    </>
  ),
  tag: (
    <>
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.4" />
    </>
  ),
  link: (
    <>
      <path d="M9.5 13.5a4.5 4.5 0 0 0 6.4.2l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5" />
      <path d="M14.5 10.5a4.5 4.5 0 0 0-6.4-.2l-2.6 2.6a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5" />
    </>
  ),
  pen: (
    <>
      <path d="M16.8 3.6a1.9 1.9 0 0 1 2.7 2.7L7.3 20.5l-3.8 1 1-3.8z" />
      <path d="M14.5 6.5l3 3" />
    </>
  ),
  chat: (
    <>
      <path d="M20.5 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.8A8 8 0 1 1 20.5 12z" />
      <path d="M8.5 12h.01M12 12h.01M15.5 12h.01" />
    </>
  ),
  megaphone: (
    <>
      <path d="M4 9.5v4.2a1 1 0 0 0 1 1h2.3L14 19.2V4.8L7.3 8.5H5a1 1 0 0 0-1 1z" />
      <path d="M17.5 8.8a4.2 4.2 0 0 1 0 6.4" />
      <path d="M7.5 15v2.8a1.8 1.8 0 0 0 3.6 0v-1" />
    </>
  ),
  note: (
    <>
      <path d="M6 2.5h7l5 5v14H6z" />
      <path d="M13 2.5V7.5h5" />
      <path d="M9 12.5h6M9 16h4" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="4" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="6.2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3.2v2.4M12 18.4v2.4M20.8 12h-2.4M5.6 12H3.2M18.2 5.8l-1.7 1.7M7.5 16.5l-1.7 1.7M18.2 18.2l-1.7-1.7M7.5 7.5 5.8 5.8" />
    </>
  ),
  qrcode: (
    <>
      <rect x="3.5" y="3.5" width="6" height="6" rx="1" />
      <rect x="14.5" y="3.5" width="6" height="6" rx="1" />
      <rect x="3.5" y="14.5" width="6" height="6" rx="1" />
      <path d="M14.5 14.5h2.5v2.5M20.5 14.5h.01M14.5 20.5h.01M17.5 20.5h.01M20.5 20.5h.01M20.5 17.5h.01" />
    </>
  ),
  book: (
    <>
      <path d="M4 4.5h6a3 3 0 0 1 2 1 3 3 0 0 1 2-1h6v14h-6a3 3 0 0 0-2 1 3 3 0 0 0-2-1H4z" />
      <path d="M12 5.5v13" />
    </>
  ),
};

export default function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
