// /crm 화면 공용 타입 (2026-11-06 개편)
import type { CrmMessage } from "@/app/lib/crm";

export type GaStat = { sessions: number; users: number; purchases: number; revenue: number };
export type GaState = { configured: boolean; stats: Record<string, GaStat> };
export type Labels = { ch: (k: string) => string; cust: (k: string) => string; type: (k: string) => string };
export type Stage = { stage: string; sub: string; stage_num: number; msgs: CrmMessage[] };
/** 판매 채널 세그먼트 값 — "" = 전체, 그 외 = 고객군 키(mall·naver·etc) */
export type Channel = string;
