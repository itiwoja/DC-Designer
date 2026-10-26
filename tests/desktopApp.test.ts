import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// library.ts などは import 時に保存先を読むので、app を読む前に一時ディレクトリを指す
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "dc-app-"));
process.env.GENERATED_DIR = mkdtempSync(join(tmpdir(), "dc-gen-"));
process.env.DC_DESIGNER_DESKTOP = "1";

const TOKEN = "a".repeat(64);
let server: Server;
let base = "";
let port = 0;
let handle: import("../server/app").AppHandle;

beforeAll(async () => {
  const { createApp } = await import("../server/app");
  handle = createApp({ mode: "desktop", token: TOKEN, instanceId: "inst1", appVersion: "9.9.9", getPort: () => port });
  server = createServer(handle.app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

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
    expect(await res.json()).toEqual({ instanceId: "inst1", apiProtocolVersion: 2, appVersion: "9.9.9", ready: true });
  });

  it("許可リスト外は 404 DESKTOP_UNAVAILABLE", async () => {
    for (const [method, path] of [["POST", "/api/plan"], ["POST", "/api/fonts/suggest"], ["GET", "/auth/callback"], ["POST", "/api/asset"], ["GET", "/api/posters/NOTANID"], ["GET", "/generated/x.png"]]) {
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
