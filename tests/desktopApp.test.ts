import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// progressRoute の失敗を作るため、再現の生成だけ差し替える
const reproduceFail = vi.hoisted(() => ({ error: undefined as unknown }));
vi.mock("../server/planner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/planner")>()),
  reproducePoster: async () => { throw reproduceFail.error; },
}));

// library.ts などは import 時に保存先を読むので、app を読む前に一時ディレクトリを指す
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "dc-app-"));
process.env.GENERATED_DIR = mkdtempSync(join(tmpdir(), "dc-gen-"));
process.env.DC_DESIGNER_DESKTOP = "1";

const TOKEN = "a".repeat(64);
let server: Server;
let base = "";
let port = 0;
let handle: import("../server/app").AppHandle;

// server/app の読み込みは /mnt/c 上だと 10 秒を超えることがあるので、前処理の期限を延ばす
beforeAll(async () => {
  const { createApp } = await import("../server/app");
  handle = createApp({ mode: "desktop", token: TOKEN, instanceId: "inst1", appVersion: "9.9.9", getPort: () => port });
  server = createServer(handle.app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
}, 60_000);
afterAll(() => { server?.closeAllConnections(); server?.close(); });

const good = { "x-dc-desktop-token": TOKEN, origin: "app://dc-designer" };
const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  fetch(base + path, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });

describe("製品版の入口", () => {
  it("token が無い・違う・長さが違うと 401", async () => {
    expect((await call("/api/desktop/health", { headers: { origin: "app://dc-designer" } })).status).toBe(401);
    expect((await call("/api/desktop/health", { headers: { ...good, "x-dc-desktop-token": "b".repeat(64) } })).status).toBe(401);
    expect((await call("/api/desktop/health", { headers: { ...good, "x-dc-desktop-token": "a" } })).status).toBe(401);
  });

  it("Origin が無い・違うと 403", async () => {
    expect((await call("/api/desktop/health", { headers: { "x-dc-desktop-token": TOKEN } })).status).toBe(403);
    expect((await call("/api/desktop/health", { headers: { ...good, origin: "http://evil.example" } })).status).toBe(403);
  });

  it("Host が実 port と一致しなければ 403", async () => {
    // fetch は Host を上書きできないので http で送る
    const http = await import("node:http");
    const status = await new Promise<number>((ok, ng) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/desktop/health", headers: { ...good, host: "localhost:" + port } }, (res) => { res.resume(); ok(res.statusCode!); });
      req.on("error", ng);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("health は DesktopHealth を返す", async () => {
    const res = await call("/api/desktop/health", { headers: good });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ instanceId: "inst1", apiProtocolVersion: 3, appVersion: "9.9.9", ready: true });
  });

  it("許可リスト外は 404 DESKTOP_UNAVAILABLE", async () => {
    for (const [method, path] of [["GET", "/auth/callback"], ["POST", "/api/asset"], ["GET", "/api/posters/NOTANID"], ["GET", "/generated/x.png"]]) {
      const res = await call(path, { method, headers: good, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect((await res.json()).code).toBe("DESKTOP_UNAVAILABLE");
    }
  });

  it("許可された操作は通る", async () => {
    const res = await call("/api/posters", { headers: good });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("posters");
  });

  it("drain 中は GET 以外が 503 BUSY、進行中が無ければ即 drained、resume で戻る", async () => {
    await handle.drain();
    const blocked = await call("/api/posters", { method: "POST", headers: good, body: "{}" });
    expect(blocked.status).toBe(503);
    expect((await blocked.json()).code).toBe("BUSY");
    expect((await call("/api/posters", { headers: good })).status).toBe(200);
    handle.resume();
    expect((await call("/api/posters", { method: "POST", headers: good, body: "{}" })).status).not.toBe(503);
  });

  it("進行中の書き込みが終わるまで drain は解決しない", async () => {
    // body を途中で止めた POST を進行中として数えさせる
    const http = await import("node:http");
    const req = http.request({ host: "127.0.0.1", port, path: "/api/posters", method: "POST", headers: { ...good, "content-type": "application/json", "content-length": "100" } });
    req.on("error", () => {});
    req.write("{");
    await new Promise((r) => setTimeout(r, 200));
    let drained = false;
    const p = handle.drain().then(() => { drained = true; });
    await new Promise((r) => setTimeout(r, 200));
    expect(drained).toBe(false);
    req.destroy();
    await p;
    expect(drained).toBe(true);
    handle.resume();
  });
});

describe("AI 操作中の drain", () => {
  it("AI 操作が進行中なら busy:true がすぐ返り、受付は止まらない", async () => {
    const http = await import("node:http");
    const req = http.request({ host: "127.0.0.1", port, path: "/api/plan", method: "POST", headers: { ...good, "content-type": "application/json", "content-length": "100" } });
    req.on("error", () => {});
    req.write("{");
    await new Promise((r) => setTimeout(r, 200));
    expect(await handle.drain()).toEqual({ busy: true });
    expect((await call("/api/posters", { method: "POST", headers: good, body: "{}" })).status).not.toBe(503);
    req.destroy();
    await new Promise((r) => setTimeout(r, 200));
    // AI 操作が終われば従来どおり
    expect(await handle.drain()).toEqual({ busy: false });
    handle.resume();
  });

  it("AI 操作が無ければ書き込みの完了を待って busy:false", async () => {
    const http = await import("node:http");
    const req = http.request({ host: "127.0.0.1", port, path: "/api/posters", method: "POST", headers: { ...good, "content-type": "application/json", "content-length": "100" } });
    req.on("error", () => {});
    req.write("{");
    await new Promise((r) => setTimeout(r, 200));
    let result: { busy: boolean } | undefined;
    const p = handle.drain().then((r) => { result = r; });
    await new Promise((r) => setTimeout(r, 200));
    expect(result).toBeUndefined();
    req.destroy();
    await p;
    expect(result).toEqual({ busy: false });
    handle.resume();
  });
});

describe("進み具合つき route のエラー", () => {
  const body = JSON.stringify({ width: 800, height: 600, reference: { mediaType: "image/png", data: "AAAA" } });
  const errorLine = async (h: Record<string, string>, b: string, url = base) => {
    const res = await fetch(url + "/api/reproduce", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: b });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    return lines[lines.length - 1] as { error: string; code?: string; status: number };
  };

  it("製品版は内部例外の中身（絶対パス）を出さない", async () => {
    reproduceFail.error = new Error("ENOENT: /home/secret/path/file.json");
    const r = await errorLine(good, body);
    expect(r.error).toBe("内部エラーが発生しました");
    expect(r.status).toBe(500);
  });

  it("製品版でも 4xx の httpError と ChatGPTError は message が残る", async () => {
    const { httpError } = await import("../server/http-error");
    const { ChatGPTError } = await import("../server/chatgpt");
    const { ChatGPTAuthError } = await import("../server/chatgpt-auth");
    reproduceFail.error = httpError(400, "参考画像が不正です");
    expect(await errorLine(good, body)).toMatchObject({ error: "参考画像が不正です", status: 400 });
    reproduceFail.error = new ChatGPTError("利用上限です", 429, "usage_limit");
    expect(await errorLine(good, body)).toMatchObject({ error: "利用上限です", status: 429, code: "usage_limit" });
    reproduceFail.error = new ChatGPTAuthError("サインインしてください");
    expect(await errorLine(good, body)).toMatchObject({ error: "サインインしてください", status: 401, code: "chatgpt_auth" });
  });

  it("開発版は従来どおり message をそのまま返す", async () => {
    const { createApp } = await import("../server/app");
    const dev = createApp({ mode: "dev", port: 0 });
    const srv = createServer(dev.app);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      reproduceFail.error = new Error("ENOENT: /home/x/file.json");
      const r = await errorLine({}, body, `http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
      expect(r.error).toBe("ENOENT: /home/x/file.json");
    } finally { srv.closeAllConnections(); srv.close(); }
  });
});

describe("ChatGPT サインインの内部 route", () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = good) => call(path, { method: "POST", headers, body: JSON.stringify(body) });

  it("start は port が 1024〜65535 の整数以外を 400 にする", async () => {
    for (const bad of [{}, { port: 80 }, { port: 70000 }, { port: 1234.5 }, { port: "5000" }, { port: 5000, extra: 1 }, { port: 5000, newAccount: "yes" }]) {
      expect((await post("/api/auth/chatgpt/start", bad)).status).toBe(400);
    }
  });

  it("complete は文字列以外の query を 400 にし、知らない state はエラー結果を返す", async () => {
    expect((await post("/api/auth/chatgpt/complete", { query: { code: 1 } })).status).toBe(400);
    expect((await post("/api/auth/chatgpt/complete", { query: "x" })).status).toBe(400);
    expect((await post("/api/auth/chatgpt/complete", {})).status).toBe(400);
    const res = await post("/api/auth/chatgpt/complete", { query: { state: "unknown", code: "x" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "error" });
  });

  it("token が無ければ 401、GET や旧 login route は 404", async () => {
    expect((await post("/api/auth/chatgpt/complete", { query: {} }, { origin: "app://dc-designer" })).status).toBe(401);
    expect((await call("/api/auth/chatgpt/start", { headers: good })).status).toBe(404);
    expect((await call("/api/auth/chatgpt/login", { headers: good })).status).toBe(404);
  });
});
