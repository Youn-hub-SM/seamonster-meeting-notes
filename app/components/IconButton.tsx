// 아이콘만 있는 버튼(✕ 삭제·닫기 등)의 공용 컴포넌트 — 접근성 이름(aria-label)과 툴팁(title)을 label 하나로 강제한다.
// 스타일은 b2b.css 의 .b2b-icon-btn(32×32). 위험 동작은 className="is-danger" 를 넘긴다.
import type { MouseEventHandler, ReactNode } from "react";

type Props = {
  /** 버튼이 하는 일(예: "줄 삭제", "닫기") — aria-label 과 title 에 같이 쓰인다 */
  label: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  /** 추가 클래스(예: "is-danger") */
  className?: string;
  /** 툴팁을 label 과 다르게 쓸 때(비활성 사유 등). 비우면 label */
  title?: string;
  style?: React.CSSProperties;
  /** 아이콘(문자 또는 SVG) */
  children: ReactNode;
};

export default function IconButton({ label, onClick, disabled, className, title, style, children }: Props) {
  return (
    <button
      type="button"
      className={`b2b-icon-btn${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
      style={style}
    >
      {children}
    </button>
  );
}
