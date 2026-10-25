// Microsoft Graph 클라이언트(서버 전용, 2026-10-25) — 업무도우미가 회사 공용 문서(SharePoint·OneDrive)를 읽는다.
//  대표 결정(2026-10-25): 회사 공용 문서만, 읽기만. 직원별 Microsoft 로그인 없이 앱 자격(client credentials) 하나로 읽는다.
//  인증: Entra 앱 등록의 테넌트 ID·클라이언트 ID·클라이언트 시크릿 → OAuth2 client_credentials 토큰(1시간, 모듈 캐시).
//  권한: 앱 권한 Sites.Selected(권장 — 사이트별로 읽기 허용) 또는 Files.Read.All·Sites.Read.All. 절차는 docs/ms365-setup.md.
//  자격 = env: MS_TENANT_ID · MS_CLIENT_ID · MS_CLIENT_SECRET. 외부 SDK 없이 fetch 만 쓴다(ga.ts 와 같은 방식).

const GRAPH = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 20_000;

export function isMsConfigured(): boolean {
  return !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

function creds() {
  const tenant = (process.env.MS_TENANT_ID || "").trim();
  const clientId = (process.env.MS_CLIENT_ID || "").trim();
  const secret = (process.env.MS_CLIENT_SECRET || "").trim();
  if (!tenant || !clientId || !secret) throw new Error("Microsoft 365 자격(MS_TENANT_ID·MS_CLIENT_ID·MS_CLIENT_SECRET)이 설정되지 않았습니다.");
  return { tenant, clientId, secret };
}

let tokenCache: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.exp - 300_000) return tokenCache.token;
  const { tenant, clientId, secret } = creds();
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret, scope: "https://graph.microsoft.com/.default" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !j.access_token) throw new Error(`Microsoft 토큰 발급 실패: ${(j.error_description || j.error || String(res.status)).split("\n")[0].slice(0, 200)}`);
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

type GraphError = { error?: { code?: string; message?: string } };

// JSON 끝점 — 실패하면 Graph 의 code·message 를 그대로 오류로(권한 부족은 'accessDenied' 로 온다 — 사이트 허용을 안 한 것).
export async function graphJson<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const token = await accessToken();
  const url = path.startsWith("https://") ? path : `${GRAPH}${path}`;
  const res = await fetch(url, {
    method: init?.method || "GET",
    headers: { Authorization: `Bearer ${token}`, ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  const j = (await res.json().catch(() => ({}))) as T & GraphError;
  if (!res.ok) {
    const code = j.error?.code || String(res.status);
    const msg = j.error?.message || "요청 실패";
    if (code === "accessDenied" || res.status === 403) throw new Error(`Microsoft 365 접근 거부(${code}) — 이 사이트에 앱 읽기 권한이 허용되지 않았습니다(docs/ms365-setup.md 의 사이트 허용 단계).`);
    if (res.status === 404) throw new Error(`Microsoft 365 에서 찾지 못했습니다(${code}): ${msg.slice(0, 160)}`);
    throw new Error(`Microsoft Graph ${res.status}(${code}): ${msg.slice(0, 200)}`);
  }
  return j;
}

// 파일 내용 — /content 는 302 로 임시 다운로드 주소를 주고 fetch 가 따라간다(다른 출처로 가며 Authorization 은 떨어진다 — 정상).
//  format=pdf 를 주면 doc·xls·ppt 같은 옛 형식을 PDF 로 변환해 받는다(Graph 지원 형식만).
export async function graphDownload(path: string, opts?: { format?: "pdf"; maxBytes?: number }): Promise<{ bytes: Buffer; contentType: string }> {
  const token = await accessToken();
  const url = `${GRAPH}${path}/content${opts?.format ? `?format=${opts.format}` : ""}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000), cache: "no-store", redirect: "follow" });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as GraphError;
    throw new Error(`파일 내려받기 실패(${res.status}${j.error?.code ? ` ${j.error.code}` : ""}): ${(j.error?.message || "").slice(0, 160)}`);
  }
  const ab = await res.arrayBuffer();
  const max = opts?.maxBytes ?? 25 * 1024 * 1024;
  if (ab.byteLength > max) throw new Error(`파일이 너무 큽니다(${Math.round(ab.byteLength / 1024 / 1024)}MB, 상한 ${Math.round(max / 1024 / 1024)}MB).`);
  return { bytes: Buffer.from(ab), contentType: res.headers.get("content-type") || "" };
}

// SharePoint 사이트·OneDrive 주소 → Graph 사이트 경로.
//  https://회사.sharepoint.com/sites/문서팀  → /sites/회사.sharepoint.com:/sites/문서팀
//  https://회사-my.sharepoint.com/personal/홍길동_회사_com → /sites/회사-my.sharepoint.com:/personal/홍길동_회사_com (개인 OneDrive 도 사이트다)
//  https://회사.sharepoint.com (루트)      → /sites/회사.sharepoint.com
export function sitePathFromUrl(input: string): string {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new Error(`사이트 주소가 올바르지 않습니다: ${input.slice(0, 80)}`); }
  if (!/\.sharepoint\.com$/i.test(u.hostname)) throw new Error(`SharePoint 주소(…sharepoint.com)만 됩니다: ${u.hostname}`);
  // /sites/xxx/Shared Documents/Forms/AllItems.aspx 처럼 사이트 뒤에 붙은 문서함 경로는 잘라낸다
  const segs = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  let keep: string[] = [];
  if (segs.length >= 2 && /^(sites|teams|personal)$/i.test(segs[0])) keep = segs.slice(0, 2);
  return keep.length ? `/sites/${u.hostname}:/${keep.join("/")}` : `/sites/${u.hostname}`;
}

export type GraphSite = { id: string; name: string; webUrl: string };
export type GraphDrive = { id: string; name: string; webUrl: string; driveType?: string };
export type GraphItem = {
  id: string; name: string; webUrl?: string; size?: number; lastModifiedDateTime?: string;
  file?: { mimeType?: string }; folder?: { childCount?: number };
  parentReference?: { driveId?: string; path?: string; id?: string };
};

export const resolveSite = (siteUrl: string) => graphJson<GraphSite>(`${sitePathFromUrl(siteUrl)}?$select=id,name,webUrl`);
export const listDrives = async (siteId: string) => (await graphJson<{ value: GraphDrive[] }>(`/sites/${siteId}/drives?$select=id,name,webUrl,driveType`)).value;

const ITEM_SELECT = "$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference";

// 드라이브 안 검색 — 이름·본문(인덱싱된 것) 모두. 폴더도 나온다.
export async function searchDrive(driveId: string, q: string, top = 20): Promise<GraphItem[]> {
  const safe = q.replace(/'/g, "''").slice(0, 200);
  const r = await graphJson<{ value: GraphItem[] }>(`/drives/${driveId}/root/search(q='${encodeURIComponent(safe)}')?${ITEM_SELECT}&$top=${top}`);
  return r.value || [];
}

// 폴더 목록 — path 는 드라이브 루트 기준('' = 루트, '보고서/2026').
export async function listChildren(driveId: string, path: string, top = 100): Promise<GraphItem[]> {
  const p = path.replace(/^\/+|\/+$/g, "");
  const base = p ? `/drives/${driveId}/root:/${p.split("/").map(encodeURIComponent).join("/")}:/children` : `/drives/${driveId}/root/children`;
  const r = await graphJson<{ value: GraphItem[] }>(`${base}?${ITEM_SELECT}&$top=${top}&$orderby=name`);
  return r.value || [];
}

export const getItem = (driveId: string, itemId: string) => graphJson<GraphItem>(`/drives/${driveId}/items/${itemId}?${ITEM_SELECT}`);

// 항목의 드라이브 안 경로('/drive/root:/보고서/2026' → '보고서/2026/파일명')
export function itemPath(it: GraphItem): string {
  const parent = (it.parentReference?.path || "").replace(/^\/drives\/[^/]+\/root:?/, "").replace(/^\/drive\/root:?/, "");
  const dir = decodeURIComponent(parent).replace(/^\/+/, "");
  return dir ? `${dir}/${it.name}` : it.name;
}
