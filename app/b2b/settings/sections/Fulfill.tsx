"use client";

import { useEffect, useMemo, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { DEFAULT_RATES, DEFAULT_EFFECTIVE, DEFAULT_BOX_CATS, validateBoxCats, type RateVersion, type BoxTier, type BoxCat } from "@/app/lib/fulfill-rates";
import { DEDUP_DEFAULT, DEDUP_MIN_DAYS, DEDUP_MAX_DAYS, type DedupConfig, type DedupMatch } from "@/app/lib/fulfill-dedup";
import { qty } from "@/app/lib/format";
import { OnOff, Pill, SetCard, SetRow, SaveBar, useDraft, useReportDirty, api, errText, hhmm, type Msg, type SectionProps } from "../ui";

// 온라인 발주 — 중복 방지 · 배송일지 박스 종류 · 적용일별 택배 단가(옛 /fulfill/settings 를 옮김).

const num = (v: string) => Math.max(0, Math.round(Number(v) || 0));
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
type Rates = { history: RateVersion[]; boxCats: BoxCat[] };

export default function FulfillSection({ onDirty }: SectionProps) {
  const confirm = useConfirm();
  const toast = useToast();
  const [err, setErr] = useState("");
  const dedup = useDraft<DedupConfig>(null);
  const rates = useDraft<Rates>(null);
  const [processed, setProcessed] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<Msg | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [d, r] = await Promise.all([
          api<{ config: DedupConfig; processedCount: number }>("/api/fulfill/dedup"),
          api<{ history: RateVersion[]; boxCats: BoxCat[] }>("/api/fulfill/rates"),
        ]);
        dedup.load(d.config); setProcessed(d.processedCount);
        // 단가를 못 읽으면 기본값을 저장값처럼 보여 주지 않는다 — 위에서 던져 편집을 막는다
        rates.load({ history: r.history?.length ? r.history : [{ ...DEFAULT_RATES, effectiveFrom: DEFAULT_EFFECTIVE }], boxCats: r.boxCats?.length ? r.boxCats : DEFAULT_BOX_CATS });
      } catch (e) { setErr(errText(e, "온라인 발주 설정을 불러오지 못했습니다. 기본값을 덮어쓰지 않도록 편집을 막았습니다 — 새로고침하세요")); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = dedup.dirty || rates.dirty;
  useReportDirty(dirty, onDirty);
  const reset = () => { dedup.reset(); rates.reset(); setSaveMsg(null); };

  const boxErrs = rates.draft ? validateBoxCats(rates.draft.boxCats, rates.draft.history[rates.draft.history.length - 1]?.boxTiers ?? DEFAULT_RATES.boxTiers) : [];

  async function save() {
    if (boxErrs.length) { setSaveMsg({ ok: false, text: "박스 종류를 먼저 고치세요" }); return; }
    if (dedup.dirty && dedup.draft && dedup.saved) {
      // 끄거나 기간을 줄이면 이미 출고한 주문이 다시 걸러지지 않는다 — CN·출고·재고 차감이 두 번 된다
      const prev = dedup.saved, next = dedup.draft;
      const warn = [
        prev.enabled && !next.enabled ? "중복 방지를 끄면 이미 출고한 주문이 섞인 파일을 올려도 걸러지지 않습니다." : "",
        next.enabled && next.windowDays < prev.windowDays ? `대조 기간을 ${prev.windowDays}일에서 ${next.windowDays}일로 줄이면 그보다 오래 전에 출고한 주문은 걸러지지 않습니다.` : "",
      ].filter(Boolean);
      if (warn.length && !(await confirm({ title: "중복 방지 설정 저장", body: `${warn.join(" ")} 그 주문은 CN 파일·출고·재고 차감에 다시 들어갑니다.`, action: "그래도 저장" }))) return;
    }
    setSaving(true); setSaveMsg(null);
    try {
      if (dedup.dirty && dedup.draft) { const j = await api<{ config: DedupConfig }>("/api/fulfill/dedup", "PUT", dedup.draft); dedup.load(j.config); }
      if (rates.dirty && rates.draft) {
        const j = await api<{ history: RateVersion[]; boxCats: BoxCat[] }>("/api/fulfill/rates", "POST", { versions: rates.draft.history, boxCats: rates.draft.boxCats });
        rates.load({ history: j.history, boxCats: j.boxCats?.length ? j.boxCats : rates.draft.boxCats });
      }
      setSaveMsg({ ok: true, text: `저장했습니다 (${hhmm()})` });
    } catch (e) { setSaveMsg({ ok: false, text: errText(e, "저장하지 못했습니다. 다시 누르세요") }); }
    setSaving(false);
  }

  const d = dedup.draft;
  const r = rates.draft;
  const setR = (fn: (x: Rates) => Rates) => rates.setDraft((p) => (p ? fn(p) : p));
  const activeIdx = useMemo(() => {
    if (!r) return 0;
    const today = kstToday();
    let best = -1, bestDate = "";
    r.history.forEach((v, i) => { if (v.effectiveFrom <= today && v.effectiveFrom >= bestDate) { best = i; bestDate = v.effectiveFrom; } });
    return best !== -1 ? best : r.history.reduce((mi, v, i, a) => (v.effectiveFrom < a[mi].effectiveFrom ? i : mi), 0);
  }, [r]);
  const patch = (idx: number, fn: (v: RateVersion) => RateVersion) => setR((x) => ({ ...x, history: x.history.map((v, i) => (i === idx ? fn(v) : v)) }));
  const setCats = (fn: (cs: BoxCat[]) => BoxCat[]) => setR((x) => ({ ...x, boxCats: fn(x.boxCats) }));

  return (
    <>
      {err && <div className="b2b-error">{err}</div>}

      <SetCard title="중복 방지" pill={!d ? null : d.enabled ? <Pill state="on">켜짐</Pill> : <Pill state="warn">꺼짐</Pill>}
        desc="이미 출고 처리한 주문이 다시 올린 발주 파일에 섞여 있으면 자동으로 뺍니다.">
        {!d ? (!err && <div className="b2b-loading">불러오는 중...</div>) : (
          <>
            <SetRow label="중복 방지" note={<>처리완료로 등록된 주문 키 <strong>{processed == null ? "—" : qty(processed)}</strong>건</>}
              control={<OnOff label="중복 방지" value={d.enabled} onChange={(v) => dedup.setDraft({ ...d, enabled: v })} />} />
            <SetRow label="같은 주문으로 보는 기준" desc={d.match === "order_only" ? "번호가 다시 쓰이는 채널에선 정상 주문도 빠질 수 있습니다" : undefined}
              control={<div className="sm-tabs set-onoff">
                {([["order_and_items", "주문번호 + 상품 구성"], ["order_only", "주문번호만"]] as [DedupMatch, string][]).map(([v, l]) => (
                  <button key={v} type="button" className={`sm-tab ${d.match === v ? "is-active" : ""}`} disabled={!d.enabled} onClick={() => dedup.setDraft({ ...d, match: v })}>{l}</button>
                ))}
              </div>} />
            <SetRow label="대조 기간" desc={`최소 ${DEDUP_MIN_DAYS}일`}
              control={<span className="sm-row" style={{ gap: "var(--sm-space-1)" }}>최근
                <input type="number" className="b2b-input set-num" min={DEDUP_MIN_DAYS} max={DEDUP_MAX_DAYS} value={d.windowDays} disabled={!d.enabled} aria-label="대조 기간(일)"
                  onChange={(e) => dedup.setDraft({ ...d, windowDays: num(e.target.value) })}
                  onBlur={() => dedup.setDraft({ ...d, windowDays: Math.min(DEDUP_MAX_DAYS, Math.max(DEDUP_MIN_DAYS, d.windowDays || DEDUP_DEFAULT.windowDays)) })} />일</span>} />
          </>
        )}
      </SetCard>

      {r && (
        <>
          <SetCard title="배송일지 박스 종류" desc="이하(kg) = 주문 총중량, 금액(원) = 박스 자재 단가(면세). 이름을 바꾸거나 지워도 과거 배송일지 기록은 그대로입니다.">
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead><tr><th>박스 종류</th><th className="num">이하(kg)</th><th className="num">금액(원)</th><th style={{ width: 40 }}></th></tr></thead>
                <tbody>
                  {r.boxCats.map((c, i) => (
                    <tr key={i}>
                      <td><input className="b2b-input" style={{ width: 140 }} value={c.name} aria-label="박스 종류 이름" onChange={(e) => setCats((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></td>
                      <td className="num">{c.maxKg == null ? <span className="sm-faint">초과(무제한)</span> : (
                        <input type="number" step="0.1" className="b2b-input b2b-money" style={{ width: 90 }} value={c.maxKg} aria-label="이하(kg)" onChange={(e) => setCats((cs) => cs.map((x, j) => (j === i ? { ...x, maxKg: Number(e.target.value) || 0 } : x)))} />
                      )}</td>
                      <td className="num"><input type="number" min={0} step={10} className="b2b-input b2b-money" style={{ width: 100 }} value={c.price ?? ""} placeholder="미입력" aria-label="금액(원)"
                        onChange={(e) => setCats((cs) => cs.map((x, j) => (j === i ? { ...x, price: e.target.value === "" ? null : num(e.target.value) } : x)))} /></td>
                      <td>{r.boxCats.length > 1 && (
                        <button type="button" className="b2b-link-btn" aria-label="빼기" onClick={() => {
                          const known = DEFAULT_BOX_CATS.some((x) => x.name === c.name);
                          setCats((cs) => { const next = cs.filter((_, j) => j !== i); next[next.length - 1] = { ...next[next.length - 1], maxKg: null }; return next; });
                          if (!known) toast.error(`'${c.name}'은 직접 추가한 종류라 저장하면 이 종류 보정의 운임 환산액이 0원이 됩니다 — 아래 [되돌리기]로 취소할 수 있습니다`);
                        }}>✕</button>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className="b2b-btn-secondary" style={{ marginTop: "var(--sm-space-2)" }} onClick={() => setCats((cs) => {
              const lastBounded = [...cs].reverse().find((x) => x.maxKg != null)?.maxKg ?? 0;
              const next = cs.map((x) => ({ ...x }));
              next[next.length - 1] = { ...next[next.length - 1], maxKg: lastBounded + 1 };
              return [...next, { name: "새 종류", maxKg: null }];
            })}>종류 추가</button>
            {boxErrs.length > 0 && <div className="b2b-error" style={{ marginTop: "var(--sm-space-2)" }}>{boxErrs.length === 1 ? boxErrs[0] : <ul>{boxErrs.map((m, i) => <li key={i}>{m}</li>)}</ul>}</div>}
          </SetCard>

          <SetCard title="택배 단가" desc="적용 시작일마다 단가를 둡니다. 각 날짜의 배송일지는 그날 유효한 단가로 계산되고, 이미 기록된 기본운임·도착보장 운임은 바뀌지 않습니다."
            actions={<button type="button" className="b2b-btn-secondary" onClick={() => setR((x) => {
              const base = x.history[x.history.length - 1] ?? { ...DEFAULT_RATES, effectiveFrom: DEFAULT_EFFECTIVE };
              return { ...x, history: [...x.history, { ...base, boxTiers: base.boxTiers.map((t) => ({ ...t })), supplies: base.supplies.map((s) => ({ ...s })), effectiveFrom: kstToday() }] };
            })}>새 단가 (적용일부터)</button>}>
            {r.history.map((v, idx) => (
              <VersionCard key={idx} v={v} active={idx === activeIdx} canDelete={r.history.length > 1}
                onDate={(dt) => patch(idx, (x) => ({ ...x, effectiveFrom: dt || DEFAULT_EFFECTIVE }))}
                onPatch={(fn) => patch(idx, fn)}
                onDelete={() => setR((x) => ({ ...x, history: x.history.length <= 1 ? x.history : x.history.filter((_, i) => i !== idx) }))} />
            ))}
          </SetCard>
        </>
      )}

      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} msg={saveMsg} />
    </>
  );
}

function VersionCard({ v, active, canDelete, onDate, onPatch, onDelete }: {
  v: RateVersion; active: boolean; canDelete: boolean;
  onDate: (d: string) => void; onPatch: (fn: (v: RateVersion) => RateVersion) => void; onDelete: () => void;
}) {
  const bounded = v.boxTiers.filter((t) => t.maxKg !== null);
  const over = v.boxTiers.find((t) => t.maxKg === null) ?? { maxKg: null, fee: 0 };
  const setTiers = (tiers: BoxTier[]) => onPatch((x) => ({ ...x, boxTiers: tiers }));
  const setBounded = (i: number, p: Partial<BoxTier>) => setTiers([...bounded.map((t, j) => (j === i ? { ...t, ...p } : t)), { maxKg: null, fee: over.fee }]);
  const addTier = () => setTiers([...bounded, { maxKg: (bounded.at(-1)?.maxKg ?? 0) + 1, fee: over.fee }, { maxKg: null, fee: over.fee }]);
  const delTier = (i: number) => setTiers([...bounded.filter((_, j) => j !== i), { maxKg: null, fee: over.fee }]);
  const setOverFee = (fee: number) => setTiers([...bounded, { maxKg: null, fee }]);

  return (
    <div className="set-version">
      <div className="sm-between" style={{ flexWrap: "wrap", gap: "var(--sm-space-2)" }}>
        <div className="sm-row-wrap" style={{ gap: "var(--sm-space-2)" }}>
          <span className="set-row-label">적용 시작일</span>
          <input type="date" className="b2b-input" style={{ width: "auto" }} value={v.effectiveFrom === DEFAULT_EFFECTIVE ? "" : v.effectiveFrom} onChange={(e) => onDate(e.target.value)} aria-label="적용 시작일" />
          {v.effectiveFrom === DEFAULT_EFFECTIVE && <span className="sm-faint">(미지정 = 처음부터)</span>}
          {active && <Pill state="on">지금 적용 중</Pill>}
        </div>
        {canDelete && <button type="button" className="b2b-link-btn" onClick={onDelete}>이 단가 삭제</button>}
      </div>

      <div className="set-sub">택배 기본운임 (주문 총중량 구간)</div>
      <div className="b2b-table-wrap">
        <table className="b2b-table">
          <thead><tr><th>박스타입</th><th className="num">이하(kg)</th><th className="num">기본운임(원)</th><th></th></tr></thead>
          <tbody>
            {bounded.map((t, i) => (
              <tr key={i}>
                <td>타입 {i + 1}</td>
                <td className="num"><input type="number" step="0.1" className="b2b-input b2b-money" style={{ width: 90 }} value={t.maxKg ?? ""} aria-label="이하(kg)" onChange={(e) => setBounded(i, { maxKg: Number(e.target.value) || 0 })} /></td>
                <td className="num"><input type="number" className="b2b-input b2b-money" style={{ width: 100 }} value={t.fee} aria-label="기본운임(원)" onChange={(e) => setBounded(i, { fee: num(e.target.value) })} /></td>
                <td><button type="button" className="b2b-link-btn" onClick={() => delTier(i)}>삭제</button></td>
              </tr>
            ))}
            <tr>
              <td>타입 {bounded.length + 1}</td>
              <td className="num sm-faint">초과</td>
              <td className="num"><input type="number" className="b2b-input b2b-money" style={{ width: 100 }} value={over.fee} aria-label="초과 기본운임(원)" onChange={(e) => setOverFee(num(e.target.value))} /></td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <button type="button" className="b2b-btn-secondary" style={{ marginTop: "var(--sm-space-2)" }} onClick={addTier}>구간 추가</button>

      <div className="b2b-field-row" style={{ marginTop: "var(--sm-space-3)" }}>
        <label className="b2b-field"><span className="b2b-field-label">도착보장 박스당 추가운임 (원)</span>
          <input type="number" className="b2b-input b2b-money" value={v.guarSurcharge} onChange={(e) => onPatch((x) => ({ ...x, guarSurcharge: num(e.target.value) }))} style={{ maxWidth: 140 }} /></label>
        <label className="b2b-field"><span className="b2b-field-label">드라이아이스 1박스 (원)</span>
          <input type="number" className="b2b-input b2b-money" value={v.dryFull} onChange={(e) => onPatch((x) => ({ ...x, dryFull: num(e.target.value) }))} style={{ maxWidth: 140 }} /></label>
        <label className="b2b-field"><span className="b2b-field-label">드라이아이스 1/2박스 (원)</span>
          <input type="number" className="b2b-input b2b-money" value={v.dryHalf} onChange={(e) => onPatch((x) => ({ ...x, dryHalf: num(e.target.value) }))} style={{ maxWidth: 140 }} /></label>
      </div>

      <div className="sm-between" style={{ marginTop: "var(--sm-space-3)" }}>
        <span className="set-sub" style={{ margin: 0 }}>박스·부자재 단가</span>
        <button type="button" className="b2b-btn-secondary" onClick={() => onPatch((x) => ({ ...x, supplies: [...x.supplies, { name: "", price: 0 }] }))}>항목 추가</button>
      </div>
      {v.supplies.length > 0 && (
        <div className="sm-col" style={{ gap: "var(--sm-space-2)", marginTop: "var(--sm-space-2)" }}>
          {v.supplies.map((s, i) => (
            <div key={i} className="sm-row" style={{ gap: "var(--sm-space-2)" }}>
              <input className="b2b-input" placeholder="박스 大" aria-label="부자재 이름" value={s.name} style={{ flex: 1 }}
                onChange={(e) => onPatch((x) => ({ ...x, supplies: x.supplies.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) }))} />
              <input type="number" className="b2b-input b2b-money" placeholder="단가" aria-label="부자재 단가" value={s.price || ""} style={{ width: 120 }}
                onChange={(e) => onPatch((x) => ({ ...x, supplies: x.supplies.map((y, j) => (j === i ? { ...y, price: num(e.target.value) } : y)) }))} />
              <button type="button" className="b2b-link-btn" onClick={() => onPatch((x) => ({ ...x, supplies: x.supplies.filter((_, j) => j !== i) }))}>삭제</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
