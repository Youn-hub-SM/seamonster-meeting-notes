import { randomUUID } from "crypto";
import { mutateKv, readKvStrict } from "./production-kv";

// ─────────────────────────────────────────────
// 수동 생산일정 — b2b_settings('production_manual') 에 배열로 저장.
//  품목·생산량만 입력하면 현재고·일평균출고·예상소진일은 박스히어로에서 자동 스냅샷.
// ─────────────────────────────────────────────

const KEY = "production_manual";

export type ProdStatus = "생산대기" | "생산중" | "생산완료";

export interface ManualProduction {
  id: string;
  sku: string;
  name: string;
  qty: number;                    // 생산량
  productionDate: string;         // YYYY-MM-DD (캘린더 배치)
  status: ProdStatus;             // 생산 진행 상태 (칸반)
  stock: number | null;           // 추가 당시 현재고 스냅샷
  dailyOut: number;               // 추가 당시 일평균출고 스냅샷
  depletionDate: string | null;   // 예상 재고소진일 스냅샷
  createdAt: string;
}

// 읽기 오류는 던진다(S4) — '빈 목록'으로 보면 추가·상태 변경·삭제가 '빈 목록 + 이번 변경'으로 전체 일정을 덮어쓴다.
//  행이 없으면(아직 저장 전) 빈 목록. 저장은 mutateKv(낙관적 잠금 + 저장 오류 확인).
const asList = (v: unknown): ManualProduction[] => (Array.isArray(v) ? (v as ManualProduction[]) : []);

export async function getManualProductions(): Promise<ManualProduction[]> {
  return asList((await readKvStrict<ManualProduction[]>(KEY)).value);
}

export async function addManualProduction(input: Partial<ManualProduction>): Promise<ManualProduction[]> {
  const sku = (input.sku || "").trim();
  const name = (input.name || "").trim();
  const qty = Math.max(0, Math.floor(Number(input.qty) || 0));
  const productionDate = (input.productionDate || "").trim();
  if (!sku || !name) throw new Error("품목을 선택하세요.");
  if (!qty) throw new Error("생산량을 입력하세요.");
  if (!productionDate) throw new Error("생산 목표일이 필요합니다.");

  const entry: ManualProduction = {
    id: randomUUID(),
    sku,
    name,
    qty,
    productionDate,
    status: "생산대기",
    stock: input.stock == null ? null : Number(input.stock),
    dailyOut: Number(input.dailyOut) || 0,
    depletionDate: input.depletionDate || null,
    createdAt: new Date().toISOString(),
  };
  return mutateKv<ManualProduction[]>(KEY, (cur) => [...asList(cur), entry]);
}

const VALID_STATUS: ProdStatus[] = ["생산대기", "생산중", "생산완료"];
export async function updateManualStatus(id: string, status: string): Promise<ManualProduction[]> {
  if (!VALID_STATUS.includes(status as ProdStatus)) throw new Error("잘못된 상태입니다.");
  return mutateKv<ManualProduction[]>(KEY, (cur) => asList(cur).map((x) => (x.id === id ? { ...x, status: status as ProdStatus } : x)));
}

export async function deleteManualProduction(id: string): Promise<ManualProduction[]> {
  return mutateKv<ManualProduction[]>(KEY, (cur) => asList(cur).filter((x) => x.id !== id));
}
