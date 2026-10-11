import { supabaseAdmin } from "./supabase";

// 생산 설정 목록(b2b_settings 한 키에 통째로 저장하는 값 — 안전재고 보정·수동 생산일정·프로모션 일정)의
//  읽기·고쳐 쓰기 공용 헬퍼(2026-10-11 원장 점검 S4).
//  · 쓰기 경로는 readKvStrict — 조회 오류를 '빈 목록'으로 보면 '빈 목록 + 이번 1건'으로 전체를 덮어쓴다. 오류면 던진다.
//  · mutateKv 는 읽은 updated_at 이 그대로일 때만 쓴다(낙관적 잠금) — 두 사람이 동시에 고치면 나중 저장이 앞 저장을
//    지우던 것을 막는다. 바뀌었으면 다시 읽어 같은 변경을 다시 얹는다(최대 4번). 저장 오류도 던진다(성공으로 응답 금지).
//  · 계산 경로는 readKvSoft — 실패해도 화면·권장은 계속 돌되 ok=false 로 알린다(호출부가 경고·초안 중단).

export type KvRead<T> = { value: T | null; updatedAt: string | null };

export async function readKvStrict<T>(key: string): Promise<KvRead<T>> {
  const { data, error } = await supabaseAdmin().from("b2b_settings").select("value, updated_at").eq("key", key).maybeSingle();
  if (error) throw new Error(`설정을 읽지 못했습니다(${error.message}) — 잠시 뒤 다시 시도하세요.`);
  if (!data) return { value: null, updatedAt: null };
  return { value: (data.value ?? null) as T | null, updatedAt: (data.updated_at as string | null) ?? null };
}

export async function readKvSoft<T>(key: string): Promise<{ value: T | null; ok: boolean }> {
  try {
    const r = await readKvStrict<T>(key);
    return { value: r.value, ok: true };
  } catch (e) {
    console.warn(`[production-kv] ${key} 조회 실패`, e instanceof Error ? e.message : e);
    return { value: null, ok: false };
  }
}

// fn(현재값) → 새 값. 현재값은 행이 없으면 null. 반환 = 저장된 새 값.
export async function mutateKv<T>(key: string, fn: (cur: T | null) => T): Promise<T> {
  const sb = supabaseAdmin();
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await readKvStrict<T>(key);
    const next = fn(cur.value);
    const now = new Date().toISOString();
    if (cur.updatedAt === null && cur.value === null) {
      // 행이 아직 없다 — insert. 그사이 다른 저장이 먼저 만들었으면(23505) 다시 읽어 얹는다.
      const { error } = await sb.from("b2b_settings").insert({ key, value: next, updated_at: now });
      if (!error) return next;
      if (error.code === "23505" || /duplicate key/i.test(error.message)) continue;
      throw new Error(`저장하지 못했습니다(${error.message})`);
    }
    let q = sb.from("b2b_settings").update({ value: next, updated_at: now }).eq("key", key);
    q = cur.updatedAt ? q.eq("updated_at", cur.updatedAt) : q.is("updated_at", null);
    const { data, error } = await q.select("key");
    if (error) throw new Error(`저장하지 못했습니다(${error.message})`);
    if ((data ?? []).length) return next;
    // 0행 = 읽은 뒤 다른 저장이 끼어들었다 — 최신 값에 이번 변경을 다시 얹는다
  }
  throw new Error("다른 사람이 같은 설정을 동시에 저장하고 있습니다 — 새로고침 후 다시 시도하세요.");
}
