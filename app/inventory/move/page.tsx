"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Combobox } from "@/app/b2b/orders/Combobox";
import { INV_CHANNELS, INV_CHANNEL_COLOR, MOVE_ONLY_CHANNELS, type InvChannel } from "@/app/lib/inventory";
import { PR_PURPOSES, PR_PURPOSE_LABEL, PURPOSE_CHANNEL } from "@/app/lib/wholesale-production";
import { deleteLedger } from "../TxnTable";
import { useConfirm } from "@/app/components/Feedback";

type Prod = { id: string; sku: string | null; name: string; spec: string | null; active?: boolean; is_bundle?: boolean; attrs?: string | null; stock_tracked?: boolean };
type Move = { group_id: string; product_name: string; sku: string | null; qty: number; from: string; to: string; txn_date: string; memo: string | null; created_by: string | null; created_at: string; complete: boolean; alloc_qty?: number; alloc_reqs?: string[] };
type Target = { item_id: string; request_id: string; req_no: string | null; title: string | null; request_date: string; due_date: string | null; requested_qty: number; received_qty: number; remaining: number };
// 이동 줄 — 여러 품목을 한 번에 옮긴다(2026-09-16 대표 요청). alloc 은 요청서(item_id)→입력값 문자열.
// tgState — 요청서 목록 상태. 실패·로딩 중을 '열린 요청 없음'으로 보여 주면 배정 없이 저장돼 요청서가 영영 안 닫힌다(최종 점검 확정).
type Line = { key: number; pid: string; plabel: string; qty: string; targets: Target[]; alloc: Map<string, string>; allocTouched?: boolean; tgState?: "loading" | "error" | "ok" };
// 프로모션 → 소매 이동이 열린 프로모션 요청서 몫을 건드린 품목(서버 409 promo_reserved 의 reserved[]) — 줄마다 몫·몫 밖 수량 표시용
type ReservedHit = { product_id: string; qty: number; reserved: number; free?: number; req_nos: string[] };

// 배정 기본값 = 이동 전량(기획 14절 4단계 #6). 목표일 빠른 순으로 각 요청서 잔여까지 채운다.
//  배정 누락 경고를 두지 않기로 했으므로(결정 21) 이 기본값이 유일한 방어다.
//  skipBefore: 그 날짜 전이 목표일인 요청서는 기본값에서 뺀다 — 프로모션은 마감 전까지 열려 있어(2026-10-06) 행사가 지난
//  요청서가 목표일 순 맨 앞에 서서 새 확보분을 가져가고, 마감 때 곧장 소매로 돌아간다. 사람이 직접 넣는 건 막지 않는다.
const prefillAlloc = (targets: Target[], qty: number, skipBefore?: string): Map<string, string> => {
  const m = new Map<string, string>();
  let left = Math.max(0, Math.round(qty * 100) / 100);
  const sorted = [...targets].filter((t) => !skipBefore || !t.due_date || String(t.due_date) >= skipBefore)
    .sort((a, b) => String(a.due_date ?? "9999").localeCompare(String(b.due_date ?? "9999")));
  for (const t of sorted) {
    if (left <= 0) break;
    const take = Math.round(Math.min(left, Math.max(0, t.remaining)) * 100) / 100;
    if (take > 0) { m.set(t.item_id, String(take)); left = Math.round((left - take) * 100) / 100; }
  }
  return m;
};

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
// 제출 키(131) — 옮기기 한 번 = 키 하나. 응답이 끊겨 다시 눌러도 이미 옮긴 줄은 다시 옮기지 않는다(서버가 품목별로 알아본다).
//  성공하면 새 키, 실패하면 그대로(재시도가 같은 키로 가야 중복이 막힌다).
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
const newLine = (key: number): Line => ({ key, pid: "", plabel: "", qty: "", targets: [], alloc: new Map() });
const nQtyOf = (l: Line) => Math.max(0, Math.round((Number(l.qty) || 0) * 100) / 100);
const allocSumOf = (l: Line) => {
  let s = 0;
  for (const t of l.targets) s += Math.max(0, Math.round((Number(l.alloc.get(t.item_id)) || 0) * 100) / 100);
  return Math.round(s * 100) / 100;
};

export default function InventoryMovePage() {
  const confirm = useConfirm();
  const [products, setProducts] = useState<Prod[]>([]);
  // 칸별 재고 — 칸이 늘 때 state·fetch·표시를 세 군데씩 고치지 않게 INV_CHANNELS 로 한 번에 돈다(115)
  //  qty = 가용(미래 발송일 선점까지 뺀 값 — 이동 상한·부족 경고의 기준), onHand = 현재고(오늘까지), sched = 출고 예정(D1·S6).
  //  onHand 가 없으면(구 서버) qty 를 현재고로 보인다.
  type Pool = { qty: number; onHand: number | null; sched: number };
  const [stock, setStock] = useState<Map<InvChannel, Map<string, Pool>>>(new Map());
  const [moves, setMoves] = useState<Move[]>([]);

  const [lines, setLines] = useState<Line[]>([newLine(1)]);
  const [nextKey, setNextKey] = useState(2);
  const [dir, setDir] = useState<{ from: InvChannel; to: InvChannel }>({ from: "소매", to: "도매" });
  const [date, setDate] = useState(kstToday());
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const submitKey = useRef(newKey());
  // 마지막 promo_reserved 응답의 품목별 몫 — 방향·품목이 바뀌거나 다시 누르면 지운다
  const [reservedHits, setReservedHits] = useState<Map<string, ReservedHit>>(new Map());
  useEffect(() => { setReservedHits(new Map()); }, [dir.from, dir.to]);

  const loadStock = useCallback(async () => {
    const [stocks, m] = await Promise.all([
      Promise.all(INV_CHANNELS.map(async (ch) => {
        const j = await fetch(`/api/inventory?channel=${encodeURIComponent(ch)}`, { cache: "no-store" }).then((x) => x.json()).catch(() => null);
        return [ch, j?.ok ? new Map<string, Pool>((j.rows || []).map((x: { product_id: string; qty: number; on_hand?: number | null; scheduled_out?: number | null }) => [x.product_id, {
          qty: Number(x.qty) || 0,
          onHand: x.on_hand != null && Number.isFinite(Number(x.on_hand)) ? Number(x.on_hand) : null,
          sched: Math.max(0, Number(x.scheduled_out) || 0),
        }])) : null] as const;
      })),
      fetch("/api/inventory/move?limit=50", { cache: "no-store" }).then((x) => x.json()).catch(() => null),
    ]);
    // 실패한 칸은 이전 값을 그대로 둔다 — 한 칸 조회가 깨졌다고 나머지 배지까지 0 으로 보이지 않게
    setStock((prev) => {
      const next = new Map(prev);
      for (const [ch, mp] of stocks) if (mp) next.set(ch, mp);
      return next;
    });
    if (m?.ok) setMoves(m.moves || []);
  }, []);
  useEffect(() => {
    // 품목 목록을 못 읽으면 빈 목록으로 두지 않고 알린다(S4) — '재고 관리 사용 안함' 표식을 못 읽은 경우도 서버가 실패로 준다
    fetch("/api/products", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (j.ok) setProducts(j.products || []); else setError(`품목 목록을 불러오지 못했습니다${j.error ? ` (${j.error})` : ""}. 새로고침하세요.`); })
      .catch(() => setError("품목 목록을 불러오지 못했습니다. 새로고침하세요."));
    loadStock();
  }, [loadStock]);

  // 배정 대상 요청서 — 목적지 칸에 대응하는 생산 용도의 열린 요청서(113·115).
  //  소매→도매='도매 납품' · 소매→프로모션='프로모션' · 소매→도매 대량='도매 대량'.
  const allocMode = dir.from === "소매" && MOVE_ONLY_CHANNELS.includes(dir.to);
  const allocPurpose = PR_PURPOSES.find((p) => PURPOSE_CHANNEL[p] === dir.to) ?? "도매 납품";
  //  실패는 null — 빈 목록([])과 구분해야 '열린 요청 없음'으로 오인하지 않는다
  const fetchTargets = useCallback(async (productId: string): Promise<Target[] | null> => {
    try {
      const j = await (await fetch(`/api/inventory/move/targets?product_id=${encodeURIComponent(productId)}&purpose=${encodeURIComponent(allocPurpose)}`, { cache: "no-store" })).json();
      return j.ok ? (j.targets || []) : null;
    } catch { return null; }
  }, [allocPurpose]);

  // 방향이 바뀌면 배정 입력 초기화(+소매→도매 복귀 시 요청서 재로드).
  //  주의: fetch 동안의 사용자 편집(수량·줄 추가)이 날아가지 않게, 착지 시 통째 교체가 아니라
  //  key 별로 targets/alloc 만 함수형 병합한다(검증 확정 보정 — 스냅샷 덮어쓰기 방지).
  useEffect(() => {
    let live = true;
    (async () => {
      const snapshot = lines;
      if (allocMode) setLines((prev) => prev.map((l) => (l.pid ? { ...l, tgState: "loading" as const } : l)));
      // 결과에 조회 시점 pid 를 붙여, 착지 시점에 그 줄의 품목이 바뀌었으면 건드리지 않는다 — 품목 변경(selectProduct)의
      //  새 목록이 먼저 오고 이 옛 목록이 나중에 오면 B 줄에 A 의 요청서가 남던 경합(감사 #42). 새 줄도 그대로 둔다.
      const targetsByKey = new Map<number, { pid: string; tg: Target[] | null }>();
      await Promise.all(snapshot.map(async (l) => {
        targetsByKey.set(l.key, { pid: l.pid, tg: l.pid && allocMode ? await fetchTargets(l.pid) : [] });
      }));
      if (!live) return;
      setLines((prev) => prev.map((l) => {
        const e = targetsByKey.get(l.key);
        if (!e || e.pid !== l.pid) return l;
        return { ...l, targets: e.tg ?? [], tgState: e.tg === null ? "error" : "ok", alloc: prefillAlloc(e.tg ?? [], nQtyOf(l), skipPast()), allocTouched: false };
      }));
    })();
    return () => { live = false; };
    // lines 를 deps 에 넣으면 무한 루프 — 방향 전환 시점의 lines 로만 요청서를 조회한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir.from, dir.to, fetchTargets]);

  const patchLine = (key: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // 현재 방향 ref — 방향 전환과 품목 선택 fetch 가 겹칠 때 구 방향의 요청서 목록이 늦게 착지해 남지 않게,
  //  착지 시점 방향이 그대로일 때만 반영한다. 용도(purpose)로 비교하면 역방향(도매→소매)도 기본값 '도매 납품'이라
  //  통과해 숨은 배정이 실려 400 이 나던 경합(감사 #42) — 방향이 용도·allocMode 를 모두 결정하므로 방향으로 본다.
  const dirRef = useRef(dir);
  useEffect(() => { dirRef.current = dir; }, [dir]);
  // 프로모션 기본 배정은 행사일이 오늘 이후인 요청서만(위 prefillAlloc 주석) — 착지 시점의 방향으로 판정
  const skipPast = () => (dirRef.current.to === "프로모션" ? kstToday() : undefined);

  async function selectProduct(key: number, id: string, label: string) {
    patchLine(key, { pid: id, plabel: label, targets: [], alloc: new Map(), tgState: allocMode ? "loading" : "ok" });
    if (allocMode) {
      const dirAtFetch = dir;
      const targets = await fetchTargets(id);
      // 빠른 재선택·방향 전환으로 응답이 뒤바뀌어도 이전 품목/방향의 요청서가 남지 않게(같은 탭 재클릭은 새 객체라 필드로 비교)
      if (dirRef.current.from !== dirAtFetch.from || dirRef.current.to !== dirAtFetch.to) return;
      setLines((prev) => prev.map((l) => (l.key === key && l.pid === id
        ? { ...l, targets: targets ?? [], tgState: targets === null ? "error" : "ok", alloc: prefillAlloc(targets ?? [], nQtyOf(l), skipPast()), allocTouched: false }
        : l)));
    }
  }

  // 열린 요청서 목록 다시 읽기(이동 취소·부분 실패 뒤) — 조회 중 품목이 바뀐 줄은 건드리지 않는다(#42 와 같은 규칙)
  async function refreshTargets(target: Line[]) {
    if (!allocMode) return;
    const dirAtFetch = dir;
    for (const l of target) if (l.pid) {
      const targets = await fetchTargets(l.pid);
      // 그사이 방향이 바뀌었으면 옛 용도의 요청서를 싣지 않는다(selectProduct 와 같은 규칙)
      if (dirRef.current.from !== dirAtFetch.from || dirRef.current.to !== dirAtFetch.to) return;
      setLines((prev) => prev.map((x) => (x.key === l.key && x.pid === l.pid
        ? (targets === null ? { ...x, tgState: "error" as const } : { ...x, targets, tgState: "ok" as const })
        : x)));
    }
  }

  // 묶음(세트)은 자체 재고가 없어 이동 대상이 아니고, 비활성(단종) 품목도 목록에서 뺀다.
  const options = useMemo(() => products
    .filter((p) => !p.is_bundle && p.active !== false && p.stock_tracked !== false) // 재고 관리 사용 안함(121) 품목 제외
    .map((p) => ({ id: p.id, label: p.spec ? `${p.name} | ${p.spec}` : p.name, sub: p.sku || "", extra: p.attrs || "" })), [products]);

  const activeLines = lines.filter((l) => l.pid && nQtyOf(l) > 0);
  const totalQty = Math.round(activeLines.reduce((s, l) => s + nQtyOf(l), 0) * 100) / 100;
  // 중복 판정은 '실제 전송될 줄' 기준 — 수량을 지운 줄까지 세면 서버는 통과인데 화면만 막는다(검증 지적)
  const dupPids = useMemo(() => {
    const seen = new Set<string>(), dup = new Set<string>();
    for (const l of activeLines) { if (seen.has(l.pid)) dup.add(l.pid); seen.add(l.pid); }
    return dup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);
  const anyAllocOver = activeLines.some((l) => allocSumOf(l) > nQtyOf(l) + 0.001);

  async function submit() {
    setError(""); setOk("");
    if (activeLines.length === 0) { setError("품목과 수량을 1줄 이상 입력하세요."); return; }
    if (dupPids.size > 0) { setError("같은 품목이 두 줄에 있습니다 — 한 줄로 합쳐 주세요."); return; }
    if (anyAllocOver) { setError("배정 합계가 이동 수량보다 많은 품목이 있습니다. 배정을 줄이세요."); return; }
    if (allocMode && activeLines.some((l) => l.tgState === "loading" || l.tgState === "error")) {
      setError("요청서 목록을 아직 불러오지 못한 품목이 있습니다. 그 줄의 '다시 불러오기'를 누른 뒤 다시 옮기세요.");
      return;
    }
    // 수량 없이 배정만 입력된 줄 — 조용히 빠지면 배정이 유실된 줄 모른다(검증 확정): 명시적으로 막는다
    const allocNoQty = lines.find((l) => l.pid && nQtyOf(l) === 0 && allocSumOf(l) > 0);
    if (allocNoQty) { setError(`'${allocNoQty.plabel}' 줄에 배정만 있고 이동 수량이 없습니다 — 수량을 넣거나 줄을 삭제하세요.`); return; }
    const items = activeLines.map((l) => ({
      product_id: l.pid,
      qty: nQtyOf(l),
      // 배정 표가 보이지 않는 방향(allocMode=false)에선 절대 배정을 싣지 않는다 — 경합으로 남은 숨은 배정 안전망
      allocations: allocMode
        ? l.targets
          .map((t) => ({ item_id: t.item_id, qty: Math.max(0, Math.round((Number(l.alloc.get(t.item_id)) || 0) * 100) / 100) }))
          .filter((a) => a.qty > 0)
        : [],
    }));
    setBusy(true);
    setReservedHits(new Map());
    try {
      type MoveRes = { ok?: boolean; error?: string; code?: string; confirm?: string; replay?: boolean; warnings?: string[]; results?: { product_id: string }[]; allocated?: number; reserved?: ReservedHit[] } | null;
      // 응답을 못 받으면(시간 초과·네트워크) 줄을 그대로 두고 같은 키로 다시 누르게 한다 — 이미 옮긴 줄은 서버가 건너뛴다
      const lost = "응답을 받지 못했습니다 — 옮겨졌을 수 있으니 아래 '최근 옮긴 내역'을 먼저 확인하세요.";
      const body = { from: dir.from, to: dir.to, txn_date: date, memo, items, request_key: submitKey.current };
      const post = async (b: Record<string, unknown>): Promise<{ res: Response; j: MoveRes }> => {
        try {
          const res = await fetch("/api/inventory/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
          return { res, j: (await res.json().catch(() => null)) as MoveRes };
        } catch { throw new Error(lost); }
      };
      let { res, j } = await post(body);
      if (!j) throw new Error(lost);
      // 프로모션 → 소매가 열린 프로모션 요청서 몫까지 빼는 경우 — 서버는 아무것도 쓰지 않고 409 를 준다.
      //  확인하면 같은 내용·같은 제출 키에 confirm_reserved 만 붙여 다시 보낸다(키를 새로 만들면 재시도 중복 방지가 끊긴다).
      //  거절하면 줄은 그대로 두고 안내만 남긴다(몫 밖 수량으로 줄이거나 요청서 '마감').
      if (res.status === 409 && j.code === "promo_reserved") {
        const hits = Array.isArray(j.reserved) ? j.reserved : [];
        setReservedHits(new Map(hits.map((h) => [h.product_id, h])));
        if (!(await confirm({ title: "프로모션 요청서 몫까지 옮기기", body: j.confirm || j.error || "열린 프로모션 요청서 몫까지 소매로 나갑니다.", action: "그래도 옮기기" }))) {
          setError(j.error || "열린 프로모션 요청서 몫까지 소매로 나갑니다.");
          setBusy(false);
          return;
        }
        ({ res, j } = await post({ ...body, confirm_reserved: true }));
        if (!j) throw new Error(lost);
        setReservedHits(new Map());
      }
      if (j.code === "request_key_conflict") submitKey.current = newKey(); // 다음 누름은 새 이동
      if (!res.ok || !j.ok) {
        // 부분 실패 응답에도 경고(앞 줄의 배정 경고 등)가 실려 온다 — 함께 표시(검증 확정 보정)
        const extra = Array.isArray(j?.warnings) && j.warnings.length ? ` ${j.warnings.join(" ")}` : "";
        setError(`${j?.error || "재고를 옮기지 못했습니다. [옮기기]를 다시 누르세요."}${extra}`);
        // 앞 품목은 이미 옮겨졌다 — 그 줄을 폼에 남기면 다시 누를 때 한 번 더 옮기고 배정도 두 번 들어간다
        //  요청 중에 바꾼 입력을 덮지 않게 최신 상태에서 빼고(함수형 갱신), 남은 줄의 요청서 목록을 다시 읽는다
        const done = new Set<string>((Array.isArray(j?.results) ? j.results : []).map((r: { product_id: string }) => r.product_id));
        if (done.size) {
          const fresh = nextKey;
          setLines((prev) => {
            const rest = prev.filter((l) => !done.has(l.pid));
            return rest.length ? rest : [newLine(fresh)];
          });
          setNextKey((k) => k + 1);
          await refreshTargets(lines.filter((l) => !done.has(l.pid)));
        }
        await loadStock();
        setBusy(false);
        return;
      }
      // 서버가 실제 기록한 배정 합(allocated) 우선 — 그 사이 닫힌 요청서로 건너뛴 배정을 '배정'으로 세지 않게(감사 #41). 구 서버면 요청값 폴백.
      const allocTotal = typeof j.allocated === "number" ? j.allocated : Math.round(items.reduce((s, it) => s + it.allocations.reduce((a, x) => a + x.qty, 0), 0) * 100) / 100;
      setOk(`${j.replay ? "이미 옮겨져 있던 이동입니다(다시 옮기지 않음) — " : ""}${items.length}개 품목 ${totalQty.toLocaleString()}개를 ${dir.from}에서 ${dir.to}로 옮겼습니다.${allocTotal > 0 ? ` (요청서 배정 ${allocTotal.toLocaleString()}, 기타 ${Math.max(0, Math.round((totalQty - allocTotal) * 100) / 100).toLocaleString()})` : ""}`);
      if (Array.isArray(j.warnings) && j.warnings.length) setError(j.warnings.join(" "));
      setLines([newLine(nextKey)]); setNextKey((k) => k + 1); setMemo("");
      submitKey.current = newKey(); // 다음 이동은 새 키
      await loadStock();
    } catch (e) { setError(e instanceof Error ? e.message : "재고를 옮기지 못했습니다. [옮기기]를 다시 누르세요."); await loadStock(); }
    setBusy(false);
  }

  async function cancelMove(group_id: string) {
    if (!(await confirm({ title: "재고 이동 취소", body: "양쪽 채널 재고가 원래대로 돌아갑니다.", action: "이동 취소" }))) return;
    // 409(규칙상 거부)엔 재시도 권유를 붙이지 않고, 응답이 끊기면 취소됐을 수 있다고 알린다(deleteLedger 공용) — 오류는 이 화면의 배너로
    const res = await deleteLedger(`/api/inventory/move?group_id=${encodeURIComponent(group_id)}`, { confirm, error: (t) => { setOk(""); setError(t); } });
    if (!res.ok) return;
    // 서버 안내(성공 notice·부분 성공 경고)는 배너로 남긴다 — 지금 move DELETE 는 싣지 않지만 공용 계약(deleteLedger)을 따른다
    if (res.notice) { if (res.warn) { setOk(""); setError(res.notice); } else { setError(""); setOk(res.notice); } }
    await loadStock();
    // 취소로 요청서 잔여·상태가 바뀌었을 수 있음 — 열려 있는 줄의 요청서 목록 갱신
    await refreshTargets(lines);
  }

  const swap = () => setDir((d) => ({ from: d.to, to: d.from }));

  return (
    <div className="b2b-container" style={{ maxWidth: 820 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">재고 이동</h1>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {ok && <div className="sm-success">✓ {ok}</div>}

      <section className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-field">
          <div className="sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div className="sm-tabs" style={{ margin: 0 }}>
              {MOVE_ONLY_CHANNELS.flatMap((ch) => [
                <button key={`to-${ch}`} className={`sm-tab ${dir.from === "소매" && dir.to === ch ? "is-active" : ""}`} onClick={() => setDir({ from: "소매", to: ch })}>소매에서 {ch}로</button>,
                <button key={`from-${ch}`} className={`sm-tab ${dir.from === ch ? "is-active" : ""}`} onClick={() => setDir({ from: ch, to: "소매" })}>{ch}에서 소매로</button>,
              ])}
            </div>
            <button className="b2b-btn-secondary" onClick={swap} style={{ padding: "6px 10px", fontSize: 12 }} title="방향 뒤집기">⇄</button>
          </div>
        </div>

        {lines.map((l, idx) => {
          const poolOf = (pool: InvChannel, pid: string): Pool => stock.get(pool)?.get(pid) ?? { qty: 0, onHand: null, sched: 0 };
          const onHandOf = (p: Pool) => p.onHand ?? p.qty;
          const fromPool = l.pid ? poolOf(dir.from, l.pid) : { qty: 0, onHand: null, sched: 0 };
          const toPool = l.pid ? poolOf(dir.to, l.pid) : { qty: 0, onHand: null, sched: 0 };
          const fromQty = fromPool.qty; // 가용 — 이동 상한
          const nQty = nQtyOf(l);
          const shortage = l.pid && nQty > 0 && nQty > fromQty;
          const allocSum = allocSumOf(l);
          const allocOver = allocSum > nQty + 0.001;
          const isDup = l.pid && dupPids.has(l.pid);
          return (
            <div key={l.key} style={{ border: "1px solid var(--sm-border)", borderRadius: 10, padding: 14, marginTop: 12 }}>
              <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span className="sm-faint" style={{ fontSize: 12, fontWeight: 700 }}>품목 {idx + 1}</span>
                {lines.length > 1 && (
                  <button className="b2b-link-btn" style={{ color: "var(--sm-danger)", fontSize: 12 }} onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}>줄 삭제</button>
                )}
              </div>
              <div className="b2b-field">
                <Combobox value={l.plabel} options={options}
                  onSelect={(o) => { void selectProduct(l.key, o.id, o.label); }}
                  placeholder="품목·SKU 검색" ariaLabel={`품목 ${idx + 1}`} />
                {isDup && <span className="b2b-field-error">같은 품목이 다른 줄에도 있습니다 — 한 줄로 합쳐 주세요</span>}
              </div>
              {l.pid && (
                <div className="sm-row" style={{ gap: 12, margin: "8px 0 0", fontSize: 13, flexWrap: "wrap", alignItems: "center" }}>
                  {/* 칸 배지 = 현재고(오늘까지). 출고 예정(미래 발송일 선점)이 있으면 함께 — 옮길 수 있는 건 가용(현재고 − 출고 예정)까지 */}
                  {INV_CHANNELS.map((ch) => {
                    const p = poolOf(ch, l.pid);
                    return <span key={ch} className="b2b-status-pill" style={{ background: INV_CHANNEL_COLOR[ch].bg, color: INV_CHANNEL_COLOR[ch].fg }}>{ch} {onHandOf(p).toLocaleString()}{p.sched > 0 ? ` (출고 예정 ${p.sched.toLocaleString()})` : ""}</span>;
                  })}
                  <input className="b2b-input b2b-money" type="number" min={0.01} step={0.01} value={l.qty}
                    onChange={(e) => {
                      const q = Math.max(0, Math.round((Number(e.target.value) || 0) * 100) / 100);
                      patchLine(l.key, { qty: e.target.value, ...(l.allocTouched ? {} : { alloc: prefillAlloc(l.targets, q, skipPast()) }) });
                    }}
                    placeholder="옮길 수량" style={{ width: 120 }} aria-label={`품목 ${idx + 1} 수량`} />
                  {nQty > 0 && (
                    <span className="sm-faint" style={{ fontSize: 12 }}>
                      옮긴 뒤 현재고 — {dir.from} {(Math.round((onHandOf(fromPool) - nQty) * 100) / 100).toLocaleString()}, {dir.to} {(Math.round((onHandOf(toPool) + nQty) * 100) / 100).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              {l.pid && reservedHits.has(l.pid) && (() => {
                const h = reservedHits.get(l.pid)!;
                return (
                  <p style={{ fontSize: 12, color: "var(--sm-warning)", margin: "6px 0 0" }}>
                    프로모션 요청서 몫 {h.reserved.toLocaleString()}개{h.req_nos.length ? `(${h.req_nos.join("·")})` : ""}
                    {typeof h.free === "number" ? `, 몫 밖 ${h.free.toLocaleString()}개` : ""}
                  </p>
                );
              })()}
              {shortage && (
                <p style={{ fontSize: 12, color: "var(--sm-danger)", margin: "6px 0 0" }}>
                  {fromPool.sched > 0
                    ? `${dir.from} 가용 재고(${fromQty.toLocaleString()} = 현재고 ${onHandOf(fromPool).toLocaleString()} − 출고 예정 ${fromPool.sched.toLocaleString()})보다 많습니다. 그래도 옮기면 출고 예정분이 모자라거나 ${dir.from}가 마이너스가 됩니다.`
                    : `${dir.from} 재고(${fromQty.toLocaleString()})보다 많습니다. 그래도 옮기면 ${dir.from}가 마이너스가 됩니다.`}
                </p>
              )}

              {allocMode && l.pid && (
                <div style={{ marginTop: 10 }}>
                  {l.tgState === "loading" ? (
                    <p className="sm-faint" style={{ fontSize: 12, margin: 0 }}>열린 {PR_PURPOSE_LABEL[allocPurpose]} 요청서를 불러오는 중...</p>
                  ) : l.tgState === "error" ? (
                    <p style={{ fontSize: 12, margin: 0, color: "var(--sm-danger)" }}>
                      요청서 목록을 불러오지 못했습니다 — 이대로는 옮길 수 없습니다.{" "}
                      <button type="button" className="b2b-link-btn" style={{ fontSize: 12 }} onClick={() => selectProduct(l.key, l.pid, l.plabel)}>다시 불러오기</button>
                    </p>
                  ) : l.targets.length === 0 ? (
                    <p className="sm-faint" style={{ fontSize: 12, margin: 0 }}>열린 {PR_PURPOSE_LABEL[allocPurpose]} 생산 요청 없음 — 전량 기타(요청 미연결)로 기록됩니다.</p>
                  ) : (
                    <>
                      <div className="b2b-table-wrap">
                        <table className="b2b-table">
                          <thead><tr><th>요청서</th><th>마감일</th><th className="num">요청</th><th className="num">기입고</th><th className="num">잔여</th><th className="num" style={{ width: 120 }}>배정 수량</th></tr></thead>
                          <tbody>
                            {l.targets.map((t) => {
                              const v = l.alloc.get(t.item_id) || "";
                              const n = Math.max(0, Math.round((Number(v) || 0) * 100) / 100);
                              const overRemain = n > t.remaining + 0.001;
                              return (
                                <tr key={t.item_id}>
                                  <td><strong>{t.req_no || "-"}</strong>{t.title ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{t.title}</span> : null}</td>
                                  <td style={{ whiteSpace: "nowrap" }}>{t.due_date || "-"}</td>
                                  <td className="num b2b-money">{t.requested_qty.toLocaleString()}</td>
                                  <td className="num b2b-money">{t.received_qty.toLocaleString()}</td>
                                  <td className="num b2b-money" style={{ fontWeight: 700 }}>{t.remaining.toLocaleString()}</td>
                                  <td className="num">
                                    <input className="b2b-input b2b-money" type="number" min={0} step={0.01} value={v}
                                      onChange={(e) => { const m2 = new Map(l.alloc); m2.set(t.item_id, e.target.value); patchLine(l.key, { alloc: m2, allocTouched: true }); }}
                                      style={{ width: 100, textAlign: "right" }} placeholder="0" aria-label={`${t.req_no || "요청서"} 배정 수량`} />
                                    {overRemain && <div style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-text-mid)" }}>잔여보다 많음</div>}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <p style={{ fontSize: 12, marginTop: 6, color: allocOver ? "var(--sm-danger)" : "var(--sm-text-mid)" }}>
                        요청서 배정 {allocSum.toLocaleString()} + 기타 {Math.max(0, Math.round((nQty - allocSum) * 100) / 100).toLocaleString()} = 이동 {nQty.toLocaleString()}
                        {allocOver && " — 배정 합계가 이동 수량보다 많아 저장할 수 없습니다"}
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}

        <div className="sm-row" style={{ marginTop: 10 }}>
          <button className="b2b-btn-secondary" style={{ fontSize: 13 }} onClick={() => { setLines((prev) => [...prev, newLine(nextKey)]); setNextKey((k) => k + 1); }}>+ 품목 추가</button>
        </div>

        {allocMode && dir.to !== "프로모션" && activeLines.some((l) => l.targets.length > 0) && (
          <p className="sm-faint" style={{ fontSize: 12, marginTop: 10 }}>배정으로 100% 채워진 요청서는 자동 완료됩니다.</p>
        )}
        {dir.to === "프로모션" && (
          <p className="sm-faint" style={{ fontSize: 12, marginTop: 6 }}>프로모션 요청서는 배정이 다 차도 열려 있습니다. 행사 판매를 시작할 때 생산 요청에서 그 요청서의 '마감'을 누르면 확보분이 소매로 넘어갑니다.</p>
        )}
        {dir.to === "도매 대량" && (
          <p className="sm-faint" style={{ fontSize: 12, marginTop: 6 }}>도매 대량 재고는 도매 일반 주문이 가져가지 못하고, 소매로 자동 합류하지 않습니다.</p>
        )}

        <div className="b2b-field-row" style={{ marginTop: 12 }}>
          <div className="b2b-field">
            <label className="b2b-field-label">옮긴 날짜</label>
            {/* 오늘까지만 — 미래 날짜 이동은 서버도 400 (마감 합류가 오늘까지의 풀만 옮기므로 미래분이 섞이면 어긋난다) */}
            <input className="b2b-input" type="date" max={kstToday()} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="b2b-field">
            <label className="b2b-field-label">메모</label>
            <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="도매 주문 대응" />
          </div>
        </div>

        <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "center", marginTop: 12, flexWrap: "wrap", gap: 8 }}>
          <span style={{ fontSize: 13 }}>{activeLines.length > 0 && <>합계 <strong>{activeLines.length}개 품목 {totalQty.toLocaleString()}개</strong></>}</span>
          <button className="b2b-btn-primary" onClick={submit} disabled={busy}>{busy ? "옮기는 중..." : `옮기기${activeLines.length > 1 ? ` (${activeLines.length}개 품목)` : ""}`}</button>
        </div>
      </section>

      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">최근 옮긴 내역</span></div>
        {moves.length === 0 ? (
          <div className="b2b-empty" style={{ padding: 20 }}>옮긴 내역이 없습니다. 위에서 품목과 수량을 넣고 [옮기기]를 누르세요.</div>
        ) : (
          <div className="b2b-table-wrap is-sticky-head">
            <table className="b2b-table">
              <thead><tr><th>날짜</th><th>품목</th><th className="num">수량</th><th>방향</th><th>담당</th><th></th></tr></thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.group_id}>
                    <td style={{ whiteSpace: "nowrap" }}>{m.txn_date}</td>
                    <td>
                      <strong>{m.product_name}</strong>
                      {m.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{m.sku}</span> : null}
                      {/* 원장 메모 '행사 종료 자동 합류' = 폐지된 자동 합류 크론(2026-10-06 삭제)의 옛 기록 — 표시만 바꾼다 */}
                      {m.memo ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>({m.memo === "행사 종료 자동 합류" ? "행사 전 자동 합류" : m.memo})</span> : null}
                      {(m.alloc_qty ?? 0) > 0 && (
                        <div className="sm-faint" style={{ fontSize: 12 }}>
                          배정 {Number(m.alloc_qty).toLocaleString()} ({(m.alloc_reqs || []).join(", ") || "요청서"})
                          {m.qty - (m.alloc_qty ?? 0) > 0.001 ? `, 기타 ${(Math.round((m.qty - (m.alloc_qty ?? 0)) * 100) / 100).toLocaleString()}` : ""}
                        </div>
                      )}
                    </td>
                    <td className="num b2b-money" style={{ fontWeight: 700 }}>{m.qty.toLocaleString()}</td>
                    <td><span className="b2b-status-pill" style={{ background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" }}>{m.from}에서 {m.to}로</span>{!m.complete && <span style={{ marginLeft: 6, fontSize: 12, color: "var(--sm-danger)" }}>불완전</span>}</td>
                    <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>{m.created_by || "-"}</td>
                    <td><button className="b2b-link-btn" onClick={() => cancelMove(m.group_id)} style={{ color: "var(--sm-danger)" }}>이동 취소</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
