/**
 * Sign in with ChatGPT（オープンソース / ローカル実行アプリ向けの ChatGPT プラン利用フロー）
 * https://developers.openai.com/siwc/token-sharing-open-source
 *
 * - 初回は client_id=dynamic_agent_client で登録し、コールバックで返る発行済み client_id（oaiapp_...）を保存して再利用する
 * - 「別のアカウントでログイン」（newAccount）は保存済みの資格情報を使わず新規登録し、サインインできたら資格情報を差し替える
 * - redirect_uri は 127.0.0.1 のループバック（/auth/callback）。localhost は不可
 * - 資格情報は server/secrets.ts 経由で保存する（開発版は ~/.config/dc-designer/chatgpt.json に 0600、製品版は main が DPAPI で保護）
 */
import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKeyInput } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getSecret, setSecret } from "./secrets";
import { homedir } from "node:os";
import { join } from "node:path";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = "https://api.openai.com/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const AGENT_NAME = "DC-Designer";
export const USAGE_URL = "https://chatgpt.com/settings/usage";

const CONFIG_DIR = process.env.DC_DESIGNER_CONFIG_DIR || join(homedir(), ".config", "dc-designer");
const HOST_FILE = join(CONFIG_DIR, "host.json");

/** ローカルの資格情報レコード（ドキュメントの例に準拠） */
interface Credential {
  email?: string;
  name?: string;
  picture?: string;
  issuer: string;
  subject: string;
  client_id: string;
  /** client_id を登録したときのアプリ名。AGENT_NAME と違えば登録し直す（ChatGPT の画面に出る名前は登録時に決まるため） */
  agent_name?: string;
  ext_agent_host_id: string;
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scopes: string[];
  saved_at: string;
}

interface Pending {
  verifier: string;
  nonce: string;
  redirectUri: string;
  /** 再認可時は保存済みの client_id。新規登録時は undefined（コールバックで受け取る） */
  clientId?: string;
  /** 再認可時に一致を確認する保存済みアカウントの sub（新規登録・やり直しでは undefined） */
  expectSubject?: string;
  returnTo: string;
  /** 別タブで開かれたサインイン（戻り先で結果を元のタブへ渡して閉じる） */
  popup: boolean;
  createdAt: number;
}

const pending = new Map<string, Pending>();
const PENDING_TTL = 10 * 60 * 1000;

// ---------- ファイル ----------
function writeSecure(path: string, data: unknown) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

/** このホスト（このPCのインストール）の安定した ext_agent_host_id。初回サインイン前に作って永続化する */
function hostId(): string {
  const saved = readJson<{ ext_agent_host_id: string }>(HOST_FILE);
  if (saved?.ext_agent_host_id) return saved.ext_agent_host_id;
  const id = `urn:uuid:${randomUUID()}`;
  writeSecure(HOST_FILE, { ext_agent_host_id: id });
  return id;
}

/** 読めない・壊れているときは null（製品版で復号できないときは getSecret が例外を投げ、再サインインへ誘導する） */
async function loadCred(): Promise<Credential | null> {
  const raw = await getSecret("chatgpt", "oauth");
  if (!raw) return null;
  try { return JSON.parse(raw) as Credential; } catch { return null; }
}
const saveCred = (c: Credential) => setSecret("chatgpt", "oauth", JSON.stringify(c, null, 2));
/** サインイン済み（アクセストークンか更新トークンが残っている） */
const hasTokens = (c: Credential | null): c is Credential => !!(c?.access_token || c?.refresh_token);

export class ChatGPTAuthError extends Error {}
const SESSION_EXPIRED = "ChatGPT のセッションが切れました。もう一度サインインしてください";

// ---------- ユーティリティ ----------
const b64url = (buf: Buffer) => buf.toString("base64url");
const random = () => b64url(randomBytes(32));
const parseScopes = (scope: string) => scope.split(/\s+/).filter(Boolean).sort();

function decodeJwt(token: string) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("ID トークンの形式が不正です");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(p, "base64url").toString("utf8")),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, "base64url"),
  };
}

let jwksCache: { keys: (JsonWebKeyInput["key"] & { kid?: string })[]; at: number } | null = null;
async function jwks(force = false) {
  if (!force && jwksCache && Date.now() - jwksCache.at < 60 * 60 * 1000) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS の取得に失敗しました (HTTP ${res.status})`);
  jwksCache = { keys: (await res.json()).keys, at: Date.now() };
  return jwksCache.keys;
}

/** ID トークンの署名（JWKS / RS256）・iss・aud・exp・nonce を検証 */
async function verifyIdToken(idToken: string, clientId: string, nonce: string) {
  const { header, payload, signingInput, signature } = decodeJwt(idToken);
  if (header.alg !== "RS256") throw new Error(`未対応の署名アルゴリズムです: ${header.alg}`);
  let jwk = (await jwks()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await jwks(true)).find((k) => k.kid === header.kid); // 鍵ローテーション直後
  if (!jwk) throw new Error("ID トークンの署名鍵が見つかりません");
  const ok = verify("RSA-SHA256", Buffer.from(signingInput), createPublicKey({ key: jwk, format: "jwk" }), signature);
  if (!ok) throw new Error("ID トークンの署名が不正です");
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== ISSUER) throw new Error("ID トークンの発行者が不正です");
  if (!aud.includes(clientId)) throw new Error("ID トークンの宛先（aud）が一致しません");
  if (typeof payload.exp !== "number" || payload.exp < now - 60) throw new Error("ID トークンの有効期限が切れています");
  if (payload.nonce !== nonce) throw new Error("ID トークンの nonce が一致しません");
  if (!payload.sub) throw new Error("ID トークンに sub がありません");
  return payload as { sub: string; email?: string; name?: string; picture?: string };
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || `HTTP ${res.status}`) as Error & { code?: string };
    err.code = json.error;
    throw err;
  }
  return json as { access_token: string; refresh_token?: string; id_token?: string; token_type: string; expires_in: number; scope?: string };
}

// ---------- 公開 API ----------

/** ブラウザで開く認可 URL を作る。newAccount は保存済みの資格情報を使わず新規登録、registeredClientId は登録済みの client_id でやり直す（内部用） */
export async function startLogin(opts: { port: number; returnTo: string; popup?: boolean; newAccount?: boolean; registeredClientId?: string }): Promise<string> {
  for (const [k, v] of pending) if (Date.now() - v.createdAt > PENDING_TTL) pending.delete(k);
  const cred = await loadCred();
  const state = random();
  const nonce = random();
  const verifier = random();
  const redirectUri = `http://127.0.0.1:${opts.port}/auth/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    ext_agent_host_id: hostId(),
  });
  // アプリ名を変えたあとは、旧名で登録した client_id を使わずに新しく登録する
  const reuse = !opts.newAccount && !opts.registeredClientId && cred?.client_id && cred.agent_name === AGENT_NAME ? cred : undefined;
  const clientId = reuse?.client_id ?? opts.registeredClientId;
  if (reuse) {
    // 再認可: 発行済み client_id を使い、agent_name_hint は付けない
    params.set("client_id", reuse.client_id);
    if (reuse.id_token) params.set("id_token_hint", reuse.id_token);
    if (reuse.email) params.set("login_hint", reuse.email);
  } else if (opts.registeredClientId) {
    // 新規登録のやり直し: 登録済みの client_id をそのまま使う（ヒントは付けない）
    params.set("client_id", opts.registeredClientId);
  } else {
    params.set("client_id", "dynamic_agent_client");
    params.set("agent_name_hint", AGENT_NAME);
  }
  pending.set(state, { verifier, nonce, redirectUri, clientId, expectSubject: reuse?.subject || undefined, returnTo: opts.returnTo, popup: !!opts.popup, createdAt: Date.now() });
  return `${AUTHORIZE_URL}?${params}`;
}

export type LoginOutcome =
  | { kind: "done"; result: "signed-in" | "no-plan" }
  | { kind: "error"; message: string }
  | { kind: "retry"; url: string };

/** state に対応する保留中のサインインを取り出す（1回限り）。無ければ null */
function takePending(query: Record<string, unknown>): Pending | null {
  const state = typeof query.state === "string" ? query.state : undefined;
  const p = state ? pending.get(state) : undefined;
  if (!state || !p) return null;
  pending.delete(state);
  return p;
}

const STATE_MISMATCH = "サインインの状態が一致しません。もう一度お試しください";

/** コールバックの結果を構造化して返す（製品版の main が使う。戻り先 URL は作らない） */
export async function completeLogin(query: Record<string, unknown>): Promise<LoginOutcome> {
  const p = takePending(query);
  if (!p) return { kind: "error", message: STATE_MISMATCH };
  return finishLogin(p, query);
}

/** /auth/callback の処理。戻り先 URL（エディタ）を返す */
export async function handleCallback(query: Record<string, unknown>): Promise<string> {
  const p = takePending(query);
  if (!p) throw new Error(STATE_MISMATCH);
  const out = await finishLogin(p, query);
  const back = (params: Record<string, string>) => `${p.returnTo}/?${new URLSearchParams(p.popup ? { ...params, popup: "1" } : params)}`;
  if (out.kind === "retry") return out.url;
  if (out.kind === "error") return back({ chatgpt_error: out.message });
  return back({ chatgpt: out.result });
}

async function finishLogin(p: Pending, query: Record<string, unknown>): Promise<LoginOutcome> {
  const q = (k: string) => (typeof query[k] === "string" ? (query[k] as string) : undefined);
  const back = (message: string): LoginOutcome => ({ kind: "error", message });

  // 以降の失敗は例外で抜けずにエラー結果として返す
  try {
    if (q("error")) {
      return back(q("error") === "access_denied" ? "サインインがキャンセルされました" : q("error_description") || q("error")!);
    }
    const code = q("code");
    if (!code) return back("認可コードが返されませんでした");

    // 新規登録ではコールバックの client_id を使う。再認可で異なる client_id が来たら拒否
    const cbClient = q("client_id");
    let clientId = p.clientId;
    if (clientId) {
      if (cbClient && cbClient !== clientId) return back("別のクライアント登録が返されました。もう一度お試しください");
    } else {
      if (!cbClient || cbClient === "dynamic_agent_client") return back("クライアント登録が完了しませんでした");
      clientId = cbClient;
    }

    let tok: Awaited<ReturnType<typeof tokenRequest>>;
    try {
      tok = await tokenRequest({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: p.verifier,
        redirect_uri: p.redirectUri,
        resource: RESOURCE,
      });
    } catch (e: any) {
      if (e?.code !== "invalid_grant") throw e;
      console.error(`[chatgpt-auth] code exchange invalid_grant (${p.clientId ? "reauth" : "new registration"}):`, e.message);
      // ドキュメント準拠: コードは破棄し、発行済み client_id で新しい認可からやり直す。
      // 資格情報は本人確認が済むまで保存しない（既存のサインインを消さないため）
      if (!p.clientId) {
        // 新規登録時のみ 1 回だけ自動でやり直す（再認可で失敗したらループさせずにエラー表示）
        return { kind: "retry", url: await startLogin({ port: Number(new URL(p.redirectUri).port), returnTo: p.returnTo, popup: p.popup, registeredClientId: clientId }) };
      }
      return back(`認可コードの交換に失敗しました（${e.message}）。もう一度サインインしてください`);
    }
    if (!tok.id_token) throw new Error("ID トークンが返されませんでした");
    const claims = await verifyIdToken(tok.id_token, clientId, p.nonce);

    // 再認可時は同じアカウントであることを確認してから資格情報を置き換える
    if (p.expectSubject && p.expectSubject !== claims.sub) {
      return back("以前と別の ChatGPT アカウントでサインインされました。別のアカウントを使う場合は「別のアカウントでログイン」からやり直してください");
    }
    const prev = await loadCred();
    const scopes = parseScopes(tok.scope ?? "");
    await saveCred({
      email: claims.email,
      name: claims.name,
      picture: claims.picture,
      issuer: ISSUER,
      subject: claims.sub,
      client_id: clientId,
      agent_name: AGENT_NAME,
      ext_agent_host_id: hostId(),
      id_token: tok.id_token,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      token_type: tok.token_type,
      expires_in: tok.expires_in,
      scopes,
      saved_at: new Date().toISOString(),
    });
    // 別のアカウント・別の登録に替わったら、置き換えられた古い更新トークンは失効させる
    if (prev && (prev.client_id !== clientId || prev.subject !== claims.sub)) await revokeRefreshToken(prev);
    return { kind: "done", result: scopes.includes(PLAN_SCOPE) ? "signed-in" : "no-plan" };
  } catch (e) {
    console.error("[chatgpt-auth] callback failed:", e);
    return back(e instanceof Error ? e.message : String(e));
  }
}

export async function authStatus() {
  const c = await loadCred();
  // 次の再認可で使われる登録済み client_id があれば、前回のアカウントのメールを案内用に返す
  const reusable = c?.client_id && c.agent_name === AGENT_NAME ? c : undefined;
  if (!hasTokens(c)) return reusable ? { signedIn: false as const, previousEmail: reusable.email } : { signedIn: false as const };
  return {
    signedIn: true as const,
    email: c.email,
    name: c.name,
    picture: c.picture,
    subject: c.subject,
    planEnabled: c.scopes.includes(PLAN_SCOPE),
  };
}

const TERMINAL_REFRESH_ERRORS = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

/** 更新トークンでアクセストークンを取り直して保存する。更新トークンが失効していればトークンを消してサインインし直してもらう */
async function refreshCredential(c: Credential & { refresh_token: string }): Promise<Credential> {
  try {
    const tok = await tokenRequest({ grant_type: "refresh_token", client_id: c.client_id, refresh_token: c.refresh_token, resource: RESOURCE });
    const next: Credential = {
      ...c,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? c.refresh_token,
      id_token: tok.id_token ?? c.id_token,
      expires_in: tok.expires_in,
      token_type: tok.token_type,
      scopes: tok.scope ? parseScopes(tok.scope) : c.scopes,
      saved_at: new Date().toISOString(),
    };
    await saveCred(next);
    return next;
  } catch (e: any) {
    if (TERMINAL_REFRESH_ERRORS.has(e?.code)) {
      // 使えなくなったトークンだけ消す（client_id は再認可で再利用）
      await saveCred({ ...c, access_token: undefined, refresh_token: undefined });
      throw new ChatGPTAuthError(SESSION_EXPIRED);
    }
    throw e;
  }
}

let refreshing: Promise<Credential> | null = null;

/** 期限切れなら更新した上でアクセストークンを返す。更新トークンはローテーションするので同時更新を 1 本にまとめる */
export async function getAccessToken(): Promise<string> {
  const c = await loadCred();
  if (!hasTokens(c)) throw new ChatGPTAuthError("ChatGPT にサインインしていません");
  if (!c.scopes.includes(PLAN_SCOPE)) throw new ChatGPTAuthError("ChatGPT プランの利用が許可されていません。もう一度サインインして許可してください");
  const expiresAt = Date.parse(c.saved_at) + (c.expires_in ?? 0) * 1000;
  if (c.access_token && Date.now() < expiresAt - 60_000) return c.access_token;
  const refreshToken = c.refresh_token;
  if (!refreshToken) throw new ChatGPTAuthError(SESSION_EXPIRED);

  refreshing ??= refreshCredential({ ...c, refresh_token: refreshToken }).finally(() => { refreshing = null; });
  return (await refreshing).access_token!;
}

/** 更新トークンを失効させる（失敗しても無視） */
async function revokeRefreshToken(c: Credential) {
  if (!c.refresh_token) return;
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: c.refresh_token, token_type_hint: "refresh_token", client_id: c.client_id }),
  }).catch(() => {});
}

/** トークンを失効させてローカルから削除。登録済み client_id とメールは次回の再認可用に残す（別のアカウントでのサインインは startLogin の newAccount で行う） */
export async function logout() {
  const c = await loadCred();
  if (!c) return;
  await revokeRefreshToken(c);
  await saveCred({ ...c, id_token: undefined, access_token: undefined, refresh_token: undefined, scopes: [] });
}

/** 戻り先はローカルのエディタだけに限定する（オープンリダイレクト防止） */
export function safeReturnTo(v: unknown): string {
  if (typeof v === "string") {
    try {
      const u = new URL(v);
      if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return u.origin;
    } catch { /* fallthrough */ }
  }
  return "http://localhost:5173";
}

