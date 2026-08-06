"use client";

// 재고 채널 UI — 조회 필터(전체/도매/소매)와 기록용 선택(도매용/소매용).
import { INV_CHANNEL_FILTERS, INV_CHANNELS, type InvChannelFilter, type InvChannel } from "@/app/lib/inventory";

// 조회 화면 필터 — 전체 = 도매+소매 합산.
export function ChannelFilter({ value, onChange, style }: { value: InvChannelFilter; onChange: (v: InvChannelFilter) => void; style?: React.CSSProperties }) {
  return (
    <div className="sm-tabs" style={{ margin: 0, ...style }} title="재고 채널">
      {INV_CHANNEL_FILTERS.map((c) => (
        <button key={c} className={`sm-tab ${value === c ? "is-active" : ""}`} onClick={() => onChange(c)}>{c}</button>
      ))}
    </div>
  );
}

// 입·출고·조정 기록 대상 채널 선택(도매용/소매용).
//  disabledChannels: 고를 수 없는 채널(예: 입고는 도매 금지 — 도매 재고는 소매↔도매 이동으로만 들어간다).
export function ChannelPicker({ value, onChange, style, disabledChannels, disabledHint }: {
  value: InvChannel; onChange: (v: InvChannel) => void; style?: React.CSSProperties;
  disabledChannels?: InvChannel[]; disabledHint?: string;
}) {
  return (
    <div className="sm-tabs" style={{ margin: 0, ...style }} title="어느 채널 재고에 기록할지">
      {INV_CHANNELS.map((c) => {
        const off = disabledChannels?.includes(c) ?? false;
        return (
          <button key={c} className={`sm-tab ${value === c ? "is-active" : ""}`} disabled={off}
            title={off ? disabledHint : undefined}
            style={off ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
            onClick={() => { if (!off) onChange(c); }}>{c}용</button>
        );
      })}
    </div>
  );
}

// 필터값(전체/도매/소매)을 기록용 채널로 — 전체면 소매 기본.
export function writeChannelOf(f: InvChannelFilter): InvChannel {
  return f === "도매" ? "도매" : "소매";
}
