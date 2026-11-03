/**
 * GitHub App のインストールトークンを取る（Issue #77）。
 * App の JWT（RS256）を WebCrypto で作り、access_tokens を呼ぶ。Issue の作成者が Bot になる。
 * Workers と Node の両方で動くよう Buffer は使わない
 */
import { FEEDBACK_REPO } from "../../desktop/feedbackRelay";

export interface GithubAppEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  /** PKCS#8 の PEM（-----BEGIN PRIVATE KEY-----） */
  GITHUB_APP_PRIVATE_KEY?: string;
}

const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const JWT_BACKDATE_SEC = 60;
const JWT_LIFETIME_SEC = 9 * 60;
/** 期限のこの時間前までは使い回す */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const PEM_RE = /^-----BEGIN PRIVATE KEY-----[A-Za-z0-9+/=\s]+-----END PRIVATE KEY-----\s*$/;

type Config = { appId: string; installationId: string; pem: string };

/** 設定が揃っていて形も正しければ取り出す。値はログに出さない */
export function readGithubAppConfig(env: GithubAppEnv): Config | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim();
  const pem = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !installationId || !pem) return null;
  if (!/^\d+$/.test(appId) || !/^\d+$/.test(installationId) || !PEM_RE.test(pem)) return null;
  return { appId, installationId, pem };
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const textB64url = (s: string) => base64url(new TextEncoder().encode(s));

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let keyCache: { pem: string; key: CryptoKey } | null = null;
let tokenCache: { id: string; token: string; expiresAt: number } | null = null;

/** テスト用：キャッシュを消す */
export function clearGithubAppCache(): void {
  keyCache = null;
  tokenCache = null;
}

async function getKey(pem: string): Promise<CryptoKey> {
  if (keyCache?.pem === pem) return keyCache.key;
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  keyCache = { pem, key };
  return key;
}

async function createJwt(cfg: Config, nowMs: number): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const head = textB64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = textB64url(JSON.stringify({ iat: now - JWT_BACKDATE_SEC, exp: now + JWT_LIFETIME_SEC, iss: cfg.appId }));
  const input = `${head}.${claims}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await getKey(cfg.pem), new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(sig))}`;
}

async function requestToken(cfg: Config, nowMs: number, signal?: AbortSignal): Promise<{ token: string; expiresAt: number } | null> {
  const jwt = await createJwt(cfg, nowMs);
  const res = await fetch(`${API}/app/installations/${cfg.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dc-designer-feedback-relay",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ repositories: [FEEDBACK_REPO.split("/")[1]], permissions: { issues: "write" } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status !== 201) {
    console.warn(`GitHub App のトークン取得が ${res.status} を返しました`);
    return null;
  }
  const data = (await res.json()) as { token?: unknown; expires_at?: unknown };
  const expiresAt = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
  if (typeof data.token !== "string" || !data.token || Number.isNaN(expiresAt)) {
    console.warn("GitHub App のトークン応答の形が想定と違います");
    return null;
  }
  return { token: data.token, expiresAt };
}

/** インストールトークンを返す。失敗は null。refresh で期限前でも取り直す。signal で全体の持ち時間を渡せる */
export async function getInstallationToken(env: GithubAppEnv, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<string | null> {
  const cfg = readGithubAppConfig(env);
  if (!cfg) return null;
  const id = `${cfg.appId}:${cfg.installationId}:${cfg.pem}`;
  const now = Date.now();
  if (!opts.refresh && tokenCache?.id === id && tokenCache.expiresAt - REFRESH_MARGIN_MS > now) return tokenCache.token;
  tokenCache = null;
  try {
    const got = await requestToken(cfg, now, opts.signal);
    if (!got) return null;
    tokenCache = { id, ...got };
    return got.token;
  } catch (e) {
    console.warn(`GitHub App のトークン取得に失敗しました: ${e instanceof Error ? e.name : "unknown"}`);
    return null;
  }
}
