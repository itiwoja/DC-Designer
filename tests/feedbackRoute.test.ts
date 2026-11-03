import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEEDBACK_RELAY_URL } from "../desktop/feedbackRelay";
import { createRouteHandlers } from "../server/route-handlers";
import { registerFeedbackRoutes } from "../server/routes/feedback";

const realFetch = globalThis.fetch;
let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const GOOD = { kind: "bug", title: "落ちる", body: "詳細" };
const FIXED = "いまは送れませんでした。時間をおいてもう一度お試しください";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function post(desktop: boolean, body: unknown, relay: (url: string, init: RequestInit) => Promise<Response>) {
  const real = realFetch;
  vi.spyOn(console, "error").mockImplementation(() => {});
  const mock = vi.fn(relay);
  const app = express();
  app.use(express.json());
  registerFeedbackRoutes(app, createRouteHandlers({ desktop }));
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // 中継への fetch だけモックし、テスト自身の呼び出しは本物を使う
  vi.stubGlobal("fetch", (u: string, i: RequestInit) => (String(u).startsWith(base) ? real(u, i) : mock(String(u), i)));
  const res = await real(`${base}/api/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { res, data: (await res.json()) as Record<string, unknown>, mock };
}

describe("POST /api/feedback", () => {
  it("201 で {number,url} を返し、中継へ JSON を POST する", async () => {
    const { res, data, mock } = await post(false, GOOD, async () => json(201, { number: 12, url: "https://github.com/itiwoja/DC-Designer/issues/12" }));
    expect(res.status).toBe(200);
    expect(data).toEqual({ number: 12, url: "https://github.com/itiwoja/DC-Designer/issues/12" });
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe(FEEDBACK_RELAY_URL);
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(init.body as string)).toEqual(GOOD);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("形が正しくなければ 400（中継は呼ばない）", async () => {
    const { res, data, mock } = await post(false, { kind: "x" }, async () => json(201, {}));
    expect(res.status).toBe(400);
    expect(data.error).toBe("送る内容の形が正しくありません");
    expect(mock).not.toHaveBeenCalled();
  });

  it("429 は中継の message を採用し、code を付ける", async () => {
    const { res, data } = await post(false, GOOD, async () => json(429, { error: "rate_limited", message: "少し待ってください" }));
    expect(res.status).toBe(429);
    expect(data).toEqual({ error: "少し待ってください", code: "feedback_rate_limited" });
  });

  it("429 の message が長すぎる・文字列でないときは固定文言", async () => {
    for (const message of ["あ".repeat(201), 5]) {
      const { res, data } = await post(false, GOOD, async () => json(429, { error: "rate_limited", message }));
      expect(res.status).toBe(429);
      expect(data.code).toBe("feedback_rate_limited");
      expect(data.error).not.toBe(message);
      expect(typeof data.error).toBe("string");
    }
  });

  it("中継の 500・201 以外・形の崩れた 201 は固定文言", async () => {
    const cases = [
      json(500, { error: "unavailable", message: "中継の内部事情" }),
      json(200, { number: 1, url: "https://github.com/a/b/issues/1" }),
      json(201, { number: 0, url: "https://github.com/a/b/issues/1" }),
      json(201, { number: 1.5, url: "https://github.com/a/b/issues/1" }),
      json(201, { number: 1, url: "https://evil.example/x" }),
      json(201, { number: "1", url: "https://github.com/a/b/issues/1" }),
      new Response("not json", { status: 201 }),
    ];
    for (const r of cases) {
      const { res, data } = await post(false, GOOD, async () => r);
      expect(res.status).toBe(503);
      expect(data).toEqual({ error: FIXED, code: "feedback_unavailable" });
    }
  });

  it("通信失敗・タイムアウトは固定文言", async () => {
    const a = await post(false, GOOD, async () => { throw new TypeError("fetch failed"); });
    expect(a.data).toEqual({ error: FIXED, code: "feedback_unavailable" });
    // 15 秒の待ちを即時に切れた信号へ差し替え、中継が信号で中断される経路を確かめる
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("timeout", "TimeoutError")));
    const b = await post(false, GOOD, async (_u, init) => { init.signal!.throwIfAborted(); return json(201, {}); });
    expect(b.data).toEqual({ error: FIXED, code: "feedback_unavailable" });
  });

  it("開発版だけ FEEDBACK_RELAY_URL で上書きできる（製品版は無視）", async () => {
    vi.stubEnv("FEEDBACK_RELAY_URL", "http://localhost:9999/v1/issues");
    const ok = { number: 1, url: "https://github.com/a/b/issues/1" };
    const dev = await post(false, GOOD, async () => json(201, ok));
    expect(dev.mock.mock.calls[0][0]).toBe("http://localhost:9999/v1/issues");
    vi.stubEnv("DC_DESIGNER_DESKTOP", "1");
    const prod = await post(true, GOOD, async () => json(201, ok));
    expect(prod.mock.mock.calls[0][0]).toBe(FEEDBACK_RELAY_URL);
  });

  it("製品版でも日本語の message と code が応答に届く（5xx の内部エラー置き換えを受けない）", async () => {
    const fail = await post(true, GOOD, async () => json(500, {}));
    expect(fail.data).toEqual({ error: FIXED, code: "feedback_unavailable" });
    const limited = await post(true, GOOD, async () => json(429, { message: "少し待ってください" }));
    expect(limited.data).toEqual({ error: "少し待ってください", code: "feedback_rate_limited" });
    const bad = await post(true, { kind: "x" }, async () => json(201, {}));
    expect(bad.data.error).toBe("送る内容の形が正しくありません");
  });
});
