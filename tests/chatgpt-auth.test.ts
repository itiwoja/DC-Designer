import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ISSUER = "https://auth.openai.com";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

// 署名鍵は全テストで共通（JWKS の応答と ID トークンの署名に使う）
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64u = (s: string) => Buffer.from(s).toString("base64url");
function signIdToken(payload: Record<string, unknown>) {
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${cryptoSign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
}
/** sub / aud / nonce を指定した ID トークン */
const idToken = (sub: string, aud: string, nonce: string) => signIdToken({
  iss: ISSUER, aud, sub, email: `${sub}@x`, nonce, exp: Math.floor(Date.now() / 1000) + 3600,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tokenOk = (id: string) => json({ access_token: "AT_NEW", refresh_token: "RT_NEW", id_token: id, token_type: "Bearer", expires_in: 3600, scope: SCOPE });
const invalidGrant = () => json({ error: "invalid_grant", error_description: "code expired" }, 400);

/** URL ごとの応答。未定義の URL は呼ばれたら失敗する */
let route: (url: string, body: URLSearchParams) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
/** 指定 URL へ送られた POST の body 一覧 */
const bodiesTo = (url: string) => fetchMock.mock.calls.filter(([u]) => u === url).map(([, init]) => new URLSearchParams(String(init?.body)));

let dir: string;
/** テストごとに設定ディレクトリを変え、モジュールを読み直す（CONFIG_DIR と JWKS キャッシュ、pending をテスト間で共有しない） */
async function load() {
  vi.resetModules();
  process.env.DC_DESIGNER_CONFIG_DIR = dir;
  return await import("../server/chatgpt-auth");
}
const credPath = () => join(dir, "chatgpt.json");
/** 保存済みのアカウント A（再認可・別アカウントのテスト用） */
function saveAccountA() {
  mkdirSync(dir, { recursive: true });
  writeFileSync(credPath(), JSON.stringify({
    email: "a@x", issuer: ISSUER, subject: "A", client_id: "oaiapp_A", agent_name: "DC-Designer",
    ext_agent_host_id: "urn:uuid:test", id_token: "old-id", access_token: "AT_A", refresh_token: "RT_A",
    token_type: "Bearer", expires_in: 3600, scopes: SCOPE.split(" ").sort(), saved_at: new Date().toISOString(),
  }));
}
const stateAndNonce = (url: string) => {
  const sp = new URL(url).searchParams;
  return { state: sp.get("state")!, nonce: sp.get("nonce")! };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chatgpt-auth-test-"));
  route = () => { throw new Error("unexpected fetch"); };
  fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => route(String(url), new URLSearchParams(String(init?.body ?? ""))));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DC_DESIGNER_CONFIG_DIR;
});

describe("コールバックの失敗は戻り先へ渡す（AUTH-002）", () => {
  it("トークン交換のネットワーク失敗でも例外にせず、popup=1 付きで戻り先へ返す", async () => {
    const auth = await load();
    const { state } = stateAndNonce(auth.startLogin({ port: 8787, returnTo: "http://localhost:5174", popup: true }));
    route = (url) => { if (url === TOKEN_URL) throw new TypeError("fetch failed"); throw new Error(`unexpected ${url}`); };
    const result = await auth.handleCallback({ state, code: "CODE", client_id: "oaiapp_NEW" });
    expect(result.startsWith("http://localhost:5174/?")).toBe(true);
    const sp = new URL(result).searchParams;
    expect(sp.get("chatgpt_error")).toBe("fetch failed");
    expect(sp.get("popup")).toBe("1");
  });

  it("JWKS の取得に失敗しても戻り先へ返す", async () => {
    const auth = await load();
    const { state, nonce } = stateAndNonce(auth.startLogin({ port: 8787, returnTo: "http://localhost:5174", popup: true }));
    route = (url) => {
      if (url === TOKEN_URL) return tokenOk(idToken("A", "oaiapp_NEW", nonce));
      if (url === JWKS_URL) return json({}, 500);
      throw new Error(`unexpected ${url}`);
    };
    const result = await auth.handleCallback({ state, code: "CODE", client_id: "oaiapp_NEW" });
    const sp = new URL(result).searchParams;
    expect(result.startsWith("http://localhost:5174/?")).toBe(true);
    expect(sp.get("chatgpt_error")).toContain("JWKS");
    expect(sp.get("popup")).toBe("1");
    expect(existsCred()).toBe(false);
  });

  it("未知の state は従来どおり例外を投げる（ルート側のフォールバック）", async () => {
    const auth = await load();
    await expect(auth.handleCallback({ state: "unknown", code: "CODE" })).rejects.toThrow();
  });
});

const existsCred = () => { try { readFileSync(credPath()); return true; } catch { return false; } };

describe("別のアカウントへの切り替え（AUTH-003）", () => {
  it("newAccount は保存済みの資格情報を使わず新規登録の URL を作る", async () => {
    saveAccountA();
    const auth = await load();
    const url = new URL(auth.startLogin({ port: 8787, returnTo: "http://localhost:5173", newAccount: true }));
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("DC-Designer");
    expect(url.searchParams.has("login_hint")).toBe(false);
    expect(url.searchParams.has("id_token_hint")).toBe(false);
  });

  it("別アカウントでサインインすると資格情報が差し替わり、古い更新トークンは失効する", async () => {
    saveAccountA();
    const auth = await load();
    const { state, nonce } = stateAndNonce(auth.startLogin({ port: 8787, returnTo: "http://localhost:5173", newAccount: true }));
    route = (url) => {
      if (url === TOKEN_URL) return tokenOk(idToken("B", "oaiapp_B", nonce));
      if (url === JWKS_URL) return json({ keys: [jwk] });
      if (url === REVOKE_URL) return json({});
      throw new Error(`unexpected ${url}`);
    };
    const result = await auth.handleCallback({ state, code: "CODE", client_id: "oaiapp_B" });
    expect(new URL(result).searchParams.get("chatgpt")).toBe("signed-in");
    const saved = JSON.parse(readFileSync(credPath(), "utf8"));
    expect(saved.subject).toBe("B");
    expect(saved.client_id).toBe("oaiapp_B");
    const revoked = bodiesTo(REVOKE_URL);
    expect(revoked).toHaveLength(1);
    expect(revoked[0].get("token")).toBe("RT_A");
  });

  it("再認可で別のアカウントが返ったら、新しい案内文で拒否し資格情報は変えない", async () => {
    saveAccountA();
    const auth = await load();
    const { state, nonce } = stateAndNonce(auth.startLogin({ port: 8787, returnTo: "http://localhost:5173" }));
    route = (url) => {
      if (url === TOKEN_URL) return tokenOk(idToken("B", "oaiapp_A", nonce));
      if (url === JWKS_URL) return json({ keys: [jwk] });
      throw new Error(`unexpected ${url}`);
    };
    const result = await auth.handleCallback({ state, code: "CODE", client_id: "oaiapp_A" });
    expect(new URL(result).searchParams.get("chatgpt_error")).toContain("別のアカウントでログイン");
    expect(JSON.parse(readFileSync(credPath(), "utf8")).subject).toBe("A");
  });

  it("サインアウト後は次回の再認可用のメールを previousEmail で返す", async () => {
    saveAccountA();
    const auth = await load();
    route = (url) => { if (url === REVOKE_URL) return json({}); throw new Error(`unexpected ${url}`); };
    await auth.logout();
    expect(auth.authStatus()).toEqual({ signedIn: false, previousEmail: "a@x" });
  });

  it("新規登録の code 交換が invalid_grant なら資格情報を書き換えず、発行済み client_id で認可をやり直す", async () => {
    saveAccountA();
    const before = readFileSync(credPath(), "utf8");
    const auth = await load();
    const { state } = stateAndNonce(auth.startLogin({ port: 8787, returnTo: "http://localhost:5173", newAccount: true }));
    route = (url) => { if (url === TOKEN_URL) return invalidGrant(); throw new Error(`unexpected ${url}`); };
    const result = await auth.handleCallback({ state, code: "CODE", client_id: "oaiapp_NEW" });
    const url = new URL(result);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(url.searchParams.get("client_id")).toBe("oaiapp_NEW");
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
    expect(readFileSync(credPath(), "utf8")).toBe(before);
  });
});
