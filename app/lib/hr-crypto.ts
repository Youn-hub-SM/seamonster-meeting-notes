// 주민등록번호 암호화 — 서버 전용(node:crypto). 화면·미들웨어에서 import 하지 말 것.
//
//  DB(hr.employees.rrn_enc)에는 여기서 만든 암호문만 들어간다. 평문은 요청을 처리하는 동안 메모리에만 있다.
//  키: 환경변수 HR_DATA_KEY — 32바이트를 16진수 64자 또는 base64 로 적은 값.
//    만들기:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//  **키를 잃으면 저장된 번호를 되살릴 수 없다.** 대표가 키를 따로 보관한다(문서 docs/payroll-leave-plan.md 3-1).
//  키가 없거나 형식이 틀리면 저장·열람 모두 거절한다 — 평문으로 대신 저장하는 길은 없다.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

function dataKey(): Buffer {
  const raw = (process.env.HR_DATA_KEY || "").trim();
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(raw)) key = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!key || key.length !== 32) {
    throw new Error("HR_DATA_KEY 가 없거나 형식이 다릅니다. 32바이트를 16진수 64자로 넣으세요.");
  }
  return key;
}
export function dataKeyReady(): boolean {
  try { dataKey(); return true; } catch { return false; }
}

// 암호문: "v1:<iv>:<tag>:<ciphertext>" (모두 base64). AES-256-GCM — 값이 한 글자라도 바뀌면 복호화가 실패한다.
export function encryptRrn(digits: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dataKey(), iv);
  const ct = Buffer.concat([c.update(digits, "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}
export function decryptRrn(enc: string): string {
  const [v, iv, tag, ct] = String(enc || "").split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("주민등록번호 암호문 형식이 다릅니다.");
  const d = createDecipheriv("aes-256-gcm", dataKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

// 같은 번호인지 비교하는 값(되돌릴 수 없음). 암호화 키에서 따로 뽑은 키로 HMAC — 암호문과 키를 나눠 쓴다.
export function rrnHash(digits: string): string {
  const k = Buffer.from(hkdfSync("sha256", dataKey(), Buffer.alloc(0), "hr-rrn-hash-v1", 32));
  return createHmac("sha256", k).update(digits).digest("hex");
}

// ── 직원 확인 링크(app/lib/hr-me.ts)가 쓰는 것 ──────────────────────
// 같은 암호화(AES-256-GCM, HR_DATA_KEY)로 짧은 비밀 글자를 감춘다 — 링크 토큰을 DB 에 평문으로 두지 않으려고.
export const sealSecret = encryptRrn;
export const openSecret = decryptRrn;
// 용도별로 따로 뽑은 서명 키(HR_DATA_KEY 에서 HKDF) — 암호화 키를 서명에 그대로 쓰지 않는다.
export function derivedKey(info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", dataKey(), Buffer.alloc(0), info, 32));
}
