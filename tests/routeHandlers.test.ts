import express, { type Request } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatGPTAuthError } from "../server/chatgpt-auth";
import { ChatGPTError } from "../server/chatgpt";
import { httpError } from "../server/http-error";
import type { OnProgress } from "../server/planner";
import { createRouteHandlers, type RouteHandlers } from "../server/route-handlers";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  vi.restoreAllMocks();
});

async function serve(app: express.Express) {
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type Format = "json" | "progress";
function endpoint(format: Format, handlers: RouteHandlers, fn: (req: Request, signal: AbortSignal) => unknown) {
  return format === "json" ? handlers.route(fn) : handlers.progressRoute(async (req, _onProgress, signal) => fn(req, signal));
}

async function* readLines(res: Response): AsyncGenerator<unknown> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        yield JSON.parse(line);
      }
    }
  } finally { reader.releaseLock(); }
}

describe.each<Format>(["json", "progress"])("共通応答処理（%s）", (format) => {
  it("入力と非同期処理の結果を返し、正常終了をキャンセル扱いにしない", async () => {
    const app = express();
    app.use(express.json());
    let signal: AbortSignal | undefined;
    app.post("/:id", endpoint(format, createRouteHandlers({ desktop: false }), async (req, s) => {
      signal = s;
      return { id: req.params.id, title: req.body.title };
    }));
    const base = await serve(app);
    const res = await fetch(`${base}/poster`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "ポスター" }) });
    const result = { id: "poster", title: "ポスター" };
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(format === "json" ? result : { result });
    expect(signal?.aborted).toBe(false);
  });

  it("アプリごとのエラー方針を保ち、認証エラーと入力エラーの詳細を返す", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express();
    let error: unknown = new Error("ENOENT: /private/work.json");
    for (const desktop of [false, true]) {
      app.get(desktop ? "/desktop" : "/dev", endpoint(format, createRouteHandlers({ desktop }), () => { throw error; }));
    }
    const base = await serve(app);
    const check = async (path: string, status: number, body: { error: string; code?: string }) => {
      const res = await fetch(base + path);
      expect(res.status).toBe(format === "json" ? status : 200);
      expect(await res.json()).toEqual(format === "json" ? body : { ...body, status });
    };
    await check("/desktop", 500, { error: "内部エラーが発生しました" });
    expect(log).toHaveBeenLastCalledWith("[api] error:", "Error");
    await check("/dev", 500, { error: "ENOENT: /private/work.json" });
    expect(log).toHaveBeenLastCalledWith(error);

    error = httpError(400, "入力が不正です");
    await check("/desktop", 400, { error: "入力が不正です" });
    error = new ChatGPTAuthError("サインインしてください");
    await check("/desktop", 401, { error: "サインインしてください", code: "chatgpt_auth" });
    error = new ChatGPTError("利用上限です", 429, "usage_limit");
    await check("/desktop", 429, { error: "利用上限です", code: "usage_limit" });
  });

  it("クライアントが途中で切断すると、実行中の処理にキャンセルを伝える", async () => {
    const started = deferred<AbortSignal>();
    const stopped = deferred<void>();
    const app = express();
    app.get("/pending", endpoint(format, createRouteHandlers({ desktop: false }), async (_req, signal) => {
      started.resolve(signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { stopped.resolve(); resolve(); }, { once: true }));
      return { ok: true };
    }));
    const base = await serve(app);
    const abort = new AbortController();
    const request = fetch(`${base}/pending`, { signal: abort.signal }).then((res) => res.text()).catch(() => {});
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    abort.abort();
    await stopped.promise;
    expect(signal.aborted).toBe(true);
    await request;
  });
});

it("進捗は最新の書き出し状態にまとめ、再試行の開始と最終結果を順番に通知する", async () => {
  const app = express();
  const complete = deferred<void>();
  let report!: OnProgress;
  const { progressRoute } = createRouteHandlers({ desktop: false });
  app.get("/stream", progressRoute(async (_req, onProgress) => {
    report = onProgress;
    report({ phase: "thinking", attempt: 1 });
    await complete.promise;
    return { reply: "生成しました" };
  }));
  const base = await serve(app);
  const res = await fetch(`${base}/stream`);
  expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  const lines = readLines(res);
  try {
    expect((await lines.next()).value).toEqual({ progress: { phase: "thinking", attempt: 1 } });
    report({ phase: "writing", attempt: 1, items: 1 });
    report({ phase: "writing", attempt: 1, items: 2 });
    expect((await lines.next()).value).toEqual({ progress: { phase: "writing", attempt: 1, items: 2 } });

    report({ phase: "writing", attempt: 1, items: 3 });
    report({ phase: "thinking", attempt: 2 });
    expect((await lines.next()).value).toEqual({ progress: { phase: "thinking", attempt: 2 } });

    report({ phase: "writing", attempt: 2, items: 1 });
    complete.resolve();
    expect((await lines.next()).value).toEqual({ result: { reply: "生成しました" } });
    expect((await lines.next()).done).toBe(true);
  } finally {
    complete.resolve();
    await lines.return(undefined);
  }
});
