// 고객 문자 발송 실행기(167) — 중계 서버(클라우드웨이즈)에서 실행. 큐가 비면 즉시 종료(부하 없음).
//  /sms 화면이 넣은 발송 요청(sms_sends 대기)을 가져와 알리고 API(/send/)로 보내고 결과를 보고한다.
//  알리고는 등록한 서버 IP 에서만 발송을 받는다 — 그래서 고정 IP 인 이 서버가 보낸다(Vercel 은 IP 가 바뀐다).
//
//  실행: node bin/aligo-sms-runner.mjs [서버URL]
//  크론(UTC — 한국 08:00~20:59 에만, 2분마다):  */2 23,0-11 * * *  cd $HOME/seamonster-sync && /usr/bin/node bin/aligo-sms-runner.mjs https://… >> logs/aligo-sms.log 2>&1
//  env(.env.local): ALIGO_API_KEY / ALIGO_USER_ID / ALIGO_SENDER(알리고에 등록한 발신번호)
//                   ALIGO_TESTMODE — 'N' 이어야 실제로 나간다. 없거나 다른 값이면 시험 발송(알리고가 접수만 하고 보내지 않음).
//                   ALIGO_API_BASE(선택, 기본 https://apis.aligo.in — 로컬 점검용)
//  보고 인증: Bearer NAVER_COMMERCE_CLIENT_SECRET (업로드 공용 시크릿)
//
//  고객에게 나가는 문자라 '많아야 한 번': 선점한 행은 이 실행 안에서 한 번만 보내고, 보고에 실패해도 다시 보내지 않는다
//  (서버가 10분 뒤 '확인 필요'로 바꾼다 — 사람이 알리고 전송 내역을 확인).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = (process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) || "https://meeting-notes-beryl.vercel.app").replace(/\/+$/, "");

const env = {};
const envPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
}
const uploadSecret = (env.NAVER_COMMERCE_CLIENT_SECRET || "").trim();
if (!uploadSecret) { console.error("[중단] NAVER_COMMERCE_CLIENT_SECRET(보고 인증) 이 없습니다."); process.exit(1); }
const ALIGO = {
  key: (env.ALIGO_API_KEY || "").trim(),
  user: (env.ALIGO_USER_ID || "").trim(),
  sender: (env.ALIGO_SENDER || "").replace(/\D/g, ""),
  test: (env.ALIGO_TESTMODE || "").trim().toUpperCase() !== "N",
  base: (env.ALIGO_API_BASE || "https://apis.aligo.in").replace(/\/+$/, ""),
};
const timeout = (ms = 30_000) => AbortSignal.timeout(ms);
const headers = { Authorization: `Bearer ${uploadSecret}`, "Content-Type": "application/json" };

async function aligo(pathname, params) {
  const body = new URLSearchParams({ key: ALIGO.key, user_id: ALIGO.user, ...params });
  const res = await fetch(`${ALIGO.base}${pathname}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body, signal: timeout() });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`알리고 응답을 읽지 못했습니다 (HTTP ${res.status})`); }
  return j;
}
async function report(id, payload) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${SERVER}/api/sms/sends?mode=report`, { method: "POST", headers, body: JSON.stringify({ id, ...payload }), signal: timeout(15_000) });
      if (res.ok) return true;
    } catch { /* 다시 */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(`  #${id} 결과 보고 실패 — 화면에는 '확인 필요'로 남습니다`);
  return false;
}

async function main() {
  const claimRes = await fetch(`${SERVER}/api/sms/sends?mode=claim`, { method: "POST", headers, body: "{}", signal: timeout(20_000) });
  if (claimRes.status === 401 || claimRes.status === 404) {
    // 아직 이 기능이 배포되지 않은 서버 — 시간당 한 줄만 남긴다
    if (new Date().getUTCMinutes() < 2) console.error(`선점 불가 (HTTP ${claimRes.status}) — 서버에 문자 보내기 기능이 아직 없습니다`);
    return;
  }
  const claimJson = await claimRes.json().catch(() => ({}));
  if (!claimRes.ok || !claimJson.ok) throw new Error(`선점 실패 (HTTP ${claimRes.status}) ${claimJson.error || ""}`.trim());
  const sends = claimJson.sends ?? [];
  if (sends.length === 0) return; // 조용히 종료
  console.log(`문자 ${sends.length}건 (${new Date().toISOString()})${ALIGO.test ? " [시험 발송]" : ""}`);

  for (const s of sends) {
    const receivers = Array.isArray(s.receivers) ? s.receivers.map((d) => String(d).replace(/\D/g, "")).filter(Boolean) : [];
    const tag = `#${s.id} ${s.msg_type} ${receivers.length}명`;
    try {
      if (!ALIGO.key || !ALIGO.user || !ALIGO.sender) throw new Error("발송 서버에 알리고 설정(API 키·아이디·발신번호)이 없습니다");
      if (!receivers.length || !String(s.message || "").trim()) throw new Error("받는 번호나 내용이 없는 요청입니다");
      if (receivers.length > 1000) throw new Error("받는 번호가 1,000개를 넘습니다");
      const params = { sender: ALIGO.sender, receiver: receivers.join(","), msg: String(s.message), msg_type: s.msg_type === "LMS" ? "LMS" : "SMS" };
      if (params.msg_type === "LMS" && s.title) params.title = String(s.title);
      if (ALIGO.test) params.testmode_yn = "Y";
      let j;
      try { j = await aligo("/send/", params); }
      catch (e) {
        // 요청은 나갔는데 답을 못 받았다 — 실제로 발송됐을 수 있어 실패로 적지 않는다(다시 보내면 두 번 나간다)
        await report(s.id, { ok: false, uncertain: true, error: `알리고 응답을 받지 못했습니다(${e?.message || e}). 알리고 전송 내역에서 발송 여부를 확인하세요.`, test: ALIGO.test });
        console.error(`  ${tag} 응답 없음: ${e?.message || e}`);
        continue;
      }
      const code = Number(j.result_code);
      if (!(code > 0)) throw new Error(`알리고 거절: ${j.message || `코드 ${j.result_code}`}`);
      let remain;
      try { const r = await aligo("/remain/", {}); if (Number(r.result_code) > 0) remain = { sms: Number(r.SMS_CNT) || 0, lms: Number(r.LMS_CNT) || 0 }; } catch { /* 잔여 조회 실패는 무시 */ }
      await report(s.id, { ok: true, msg_id: j.msg_id, success_cnt: Number(j.success_cnt) || 0, error_cnt: Number(j.error_cnt) || 0, test: ALIGO.test, remain });
      console.log(`  ${tag} 접수 ${j.success_cnt}건 · 거절 ${j.error_cnt}건 (알리고 ${j.msg_id})`);
    } catch (e) {
      const msg = e?.message || String(e);
      await report(s.id, { ok: false, error: msg, test: ALIGO.test });
      console.error(`  ${tag} 실패: ${msg}`);
    }
  }
}

main().catch((e) => { console.error(`[중단] ${e?.message || e}`); process.exit(1); });
