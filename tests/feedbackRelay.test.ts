import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearGithubAppCache } from "../relay/src/githubApp";
import { buildIssue, handleRequest, neutralizeMentions, MAX_REQUEST_BYTES, type Env } from "../relay/src/index";

const ZW = "​";
const URL_ = "https://relay.example/v1/issues";

type Over = Partial<{ perIp: boolean; global: boolean; appId: string | undefined; installationId: string | undefined; key: string | undefined }>;

let pem = "";
let publicKey: CryptoKey;

function toPem(der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  pem = toPem(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  publicKey = pair.publicKey;
});

function makeEnv(over: Over = {}) {
  const perIp = vi.fn(async () => ({ success: over.perIp ?? true }));
  const global = vi.fn(async () => ({ success: over.global ?? true }));
  const env: Env = {
    GITHUB_APP_ID: "appId" in over ? over.appId : "12345",
    GITHUB_APP_INSTALLATION_ID: "installationId" in over ? over.installationId : "678",
    GITHUB_APP_PRIVATE_KEY: "key" in over ? over.key : pem,
    PER_IP: { limit: perIp },
    GLOBAL: { limit: global },
  };
  return { env, perIp, global };
}

function post(body: unknown, init: RequestInit & { raw?: string } = {}) {
  const { raw, headers, ...rest } = init;
  return new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4", ...(headers as Record<string, string>) },
    body: raw ?? JSON.stringify(body),
    ...rest,
  });
}

const valid = { kind: "request", title: "ほしい機能", body: "本文です" };

const ISSUES_URL = "https://api.github.com/repos/itiwoja/DC-Designer/issues";
const TOKEN_URL = "https://api.github.com/app/installations/678/access_tokens";
const issueOk = () => new Response(JSON.stringify({ number: 12, html_url: "https://github.com/itiwoja/DC-Designer/issues/12" }), { status: 201 });
const tokenOk = (token = "ghs_install") =>
  new Response(JSON.stringify({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 });

let fetchMock: ReturnType<typeof vi.fn>;
/** Issue 作成・トークン取得それぞれの応答（テストで差し替える） */
let onIssue: () => Response | Promise<Response>;
let onToken: () => Response | Promise<Response>;
const callsTo = (url: string) => fetchMock.mock.calls.filter((c) => c[0] === url) as [string, RequestInit][];

beforeEach(() => {
  clearGithubAppCache();
  onIssue = issueOk;
  onToken = () => tokenOk();
  fetchMock = vi.fn(async (url: string) => (url === TOKEN_URL ? onToken() : url === ISSUES_URL ? onIssue() : new Response("", { status: 404 })));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

describe("buildIssue", () => {
  it("件名に種類の接頭辞を付け、ラベルを付ける", () => {
    const issue = buildIssue({ kind: "bug", title: "落ちる", body: "x" });
    expect(issue.title).toBe("[不具合] 落ちる");
    expect(issue.labels).toEqual(["from-app", "bug"]);
    expect(buildIssue({ kind: "request", title: "a", body: "" }).labels).toEqual(["from-app", "enhancement"]);
    expect(buildIssue({ kind: "question", title: "a", body: "" }).labels).toEqual(["from-app", "question"]);
  });

  it("件名は 200 文字で切る", () => {
    expect(buildIssue({ kind: "request", title: "あ".repeat(200), body: "" }).title).toHaveLength(200);
  });

  it("env が無いときは環境節を付けない", () => {
    const { body } = buildIssue({ kind: "request", title: "t", body: "本文" });
    expect(body).toBe("本文\n\n---\n_アプリ内の「要望・不具合を送る」から匿名で送られました。_");
    expect(body).not.toContain("環境");
  });

  it("env があれば環境節を本文と末尾の間に入れる", () => {
    const { body } = buildIssue({ kind: "request", title: "t", body: "本文", env: { appVersion: "1.0.8", desktop: true, os: "Windows 11" } });
    expect(body).toBe(
      "本文\n\n---\n環境\n- アプリの版: 1.0.8\n- 種類: 製品版\n- OS: Windows 11\n\n---\n_アプリ内の「要望・不具合を送る」から匿名で送られました。_",
    );
  });

  it("env が空の項目は「不明」、開発版", () => {
    const { body } = buildIssue({ kind: "request", title: "t", body: "b", env: { appVersion: "", desktop: false, os: "" } });
    expect(body).toContain("- アプリの版: 不明\n- 種類: 開発版\n- OS: 不明");
  });

  it("本文・件名の @ を無効にする", () => {
    const issue = buildIssue({ kind: "request", title: "@octocat 見て", body: "cc @org/team と a@b.com", env: { appVersion: "@v", desktop: false, os: "@os" } });
    expect(issue.title).toBe(`[要望] @${ZW}octocat 見て`);
    expect(issue.body).not.toMatch(/@(?!​)/);
    expect(issue.body).toContain(`@${ZW}org/team`);
  });

  it("neutralizeMentions は @ の直後にだけ U+200B を入れる", () => {
    expect(neutralizeMentions("a@b @@c")).toBe(`a@${ZW}b @${ZW}@${ZW}c`);
  });
});

describe("handleRequest", () => {
  it("正常: GitHub を呼んで 201 {number,url} を返す", async () => {
    const { env, perIp, global } = makeEnv();
    const res = await handleRequest(post(valid), env);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ number: 12, url: "https://github.com/itiwoja/DC-Designer/issues/12" });
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(perIp).toHaveBeenCalledWith({ key: "1.2.3.4" });
    expect(global).toHaveBeenCalledWith({ key: "all" });

    const [[url, init]] = callsTo(ISSUES_URL);
    expect(url).toBe(ISSUES_URL);
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer ghs_install");
    expect(h.Accept).toBe("application/vnd.github+json");
    expect(h["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(h["User-Agent"]).toBe("dc-designer-feedback-relay");
    const sent = JSON.parse(init.body as string);
    expect(sent.title).toBe("[要望] ほしい機能");
    expect(sent.labels).toEqual(["from-app", "enhancement"]);
  });

  it("形が正しくなければ 400（GitHub は呼ばない）", async () => {
    const { env } = makeEnv();
    for (const req of [post({ kind: "x", title: "t", body: "" }), post(null, { raw: "{not json" }), post({ kind: "bug", title: "  ", body: "" })]) {
      const res = await handleRequest(req, env);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid", message: "送る内容の形が正しくありません" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("他の path は 404、他の method は 405", async () => {
    const { env } = makeEnv();
    expect((await handleRequest(new Request("https://relay.example/other", { method: "POST" }), env)).status).toBe(404);
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await handleRequest(new Request(URL_, { method }), env);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }
  });

  it("Content-Type が JSON でなければ 415", async () => {
    const { env } = makeEnv();
    const res = await handleRequest(post(valid, { headers: { "Content-Type": "text/plain" } }), env);
    expect(res.status).toBe(415);
  });

  it("charset 付きの JSON は通る", async () => {
    const { env } = makeEnv();
    const res = await handleRequest(post(valid, { headers: { "Content-Type": "application/json; charset=utf-8" } }), env);
    expect(res.status).toBe(201);
  });

  it("Content-Length が上限を超えれば 413", async () => {
    const { env } = makeEnv();
    const res = await handleRequest(post(valid, { headers: { "Content-Length": String(MAX_REQUEST_BYTES + 1) } }), env);
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("実際の長さが上限を超えれば 413（Content-Length が無くても）", async () => {
    const { env } = makeEnv();
    const big = JSON.stringify({ ...valid, body: "a".repeat(MAX_REQUEST_BYTES) });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const req = new Request(URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect((await handleRequest(req, env)).status).toBe(413);
  });

  it("レート制限（IP ごと・全体）を超えれば 429", async () => {
    for (const over of [{ perIp: false }, { global: false }]) {
      const { env } = makeEnv(over);
      const res = await handleRequest(post(valid), env);
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "rate_limited", message: "送信が多すぎます。少し時間をおいてから送ってください" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GitHub が失敗しても、エラー本文やトークンを応答に出さない", async () => {
    onIssue = () => new Response('{"message":"Bad credentials ghs_install"}', { status: 403 });
    const { env } = makeEnv();
    const res = await handleRequest(post(valid), env);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "unavailable", message: "いまは送れませんでした。時間をおいてもう一度お試しください" });
    expect(text).not.toContain("Bad credentials");
    expect(text).not.toContain("ghs_install");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("403"));
  });

  it("fetch が例外でも 502", async () => {
    onIssue = () => {
      throw new Error("boom ghs_install");
    };
    const { env } = makeEnv();
    const res = await handleRequest(post(valid), env);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("boom");
  });

  it("html_url が github.com でなければ 502", async () => {
    onIssue = () => new Response(JSON.stringify({ number: 1, html_url: "https://evil.example/x" }), { status: 201 });
    const { env } = makeEnv();
    expect((await handleRequest(post(valid), env)).status).toBe(502);
  });

  it("App の設定が欠ける・形が違えば 503（GitHub は呼ばない）", async () => {
    const bad: Over[] = [
      { appId: undefined },
      { installationId: undefined },
      { key: undefined },
      { appId: "abc" },
      { installationId: "12x" },
      { key: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----" },
    ];
    for (const over of bad) {
      const { env } = makeEnv(over);
      const res = await handleRequest(post(valid), env);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable", message: "いまは送れませんでした。時間をおいてもう一度お試しください" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GitHub App 認証", () => {
  it("access_tokens への JWT が公開鍵で検証でき、iss・iat・exp が正しい", async () => {
    const { env } = makeEnv();
    const before = Math.floor(Date.now() / 1000);
    expect((await handleRequest(post(valid), env)).status).toBe(201);
    const after = Math.floor(Date.now() / 1000);

    const [[url, init]] = callsTo(TOKEN_URL);
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h.Accept).toBe("application/vnd.github+json");
    expect(h["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(h["User-Agent"]).toBe("dc-designer-feedback-relay");
    expect(JSON.parse(init.body as string)).toEqual({ repositories: ["DC-Designer"], permissions: { issues: "write" } });

    const jwt = h.Authorization.replace("Bearer ", "");
    const [head, claims, sig] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64urlToBytes(head)))).toEqual({ alg: "RS256", typ: "JWT" });
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, b64urlToBytes(sig), new TextEncoder().encode(`${head}.${claims}`));
    expect(ok).toBe(true);
    const c = JSON.parse(new TextDecoder().decode(b64urlToBytes(claims)));
    expect(c.iss).toBe("12345");
    expect(c.iat).toBeGreaterThanOrEqual(before - 60);
    expect(c.iat).toBeLessThanOrEqual(after - 60);
    expect(c.exp - c.iat).toBe(600);
    expect(c.exp).toBeGreaterThanOrEqual(before + 540);
    expect(c.exp).toBeLessThanOrEqual(after + 540);
  });

  it("インストールトークンで Issue を作る", async () => {
    onToken = () => tokenOk("ghs_abc");
    const { env } = makeEnv();
    expect((await handleRequest(post(valid), env)).status).toBe(201);
    const [[, init]] = callsTo(ISSUES_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ghs_abc");
  });

  it("2 回目はトークンを取り直さない", async () => {
    const { env } = makeEnv();
    expect((await handleRequest(post(valid), env)).status).toBe(201);
    expect((await handleRequest(post(valid), env)).status).toBe(201);
    expect(callsTo(TOKEN_URL)).toHaveLength(1);
    expect(callsTo(ISSUES_URL)).toHaveLength(2);
  });

  it("Issue 作成が 401 ならキャッシュを捨てて 1 回だけ取り直して再試行する", async () => {
    let n = 0;
    onToken = () => tokenOk(`ghs_${++n}`);
    onIssue = () => (n === 1 ? new Response("{}", { status: 401 }) : issueOk());
    const { env } = makeEnv();
    const res = await handleRequest(post(valid), env);
    expect(res.status).toBe(201);
    expect(callsTo(TOKEN_URL)).toHaveLength(2);
    const issues = callsTo(ISSUES_URL);
    expect(issues).toHaveLength(2);
    expect((issues[1][1].headers as Record<string, string>).Authorization).toBe("Bearer ghs_2");
  });

  it("取り直しても 401 なら 502（再試行は 1 回だけ）", async () => {
    onIssue = () => new Response("{}", { status: 401 });
    const { env } = makeEnv();
    expect((await handleRequest(post(valid), env)).status).toBe(502);
    expect(callsTo(TOKEN_URL)).toHaveLength(2);
    expect(callsTo(ISSUES_URL)).toHaveLength(2);
  });

  it("access_tokens の失敗は 502 で、本文・JWT を漏らさない", async () => {
    const cases: Array<() => Response | Promise<Response>> = [
      () => new Response('{"message":"Bad credentials SECRETBODY"}', { status: 401 }),
      () => new Response(JSON.stringify({ expires_at: "x" }), { status: 201 }),
      () => {
        throw new Error("boom SECRETBODY");
      },
    ];
    for (const c of cases) {
      clearGithubAppCache();
      onToken = c;
      const { env } = makeEnv();
      const res = await handleRequest(post(valid), env);
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "unavailable", message: "いまは送れませんでした。時間をおいてもう一度お試しください" });
      expect(text).not.toContain("SECRETBODY");
    }
    expect(callsTo(ISSUES_URL)).toHaveLength(0);
    const logs = JSON.stringify([...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]);
    expect(logs).not.toContain("SECRETBODY");
    expect(logs).not.toContain("eyJ");
    expect(logs).toContain("401");
  });
});
