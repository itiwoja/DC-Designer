import { afterEach, describe, expect, it, vi } from "vitest";
import { postWithProgress, request } from "../src/editor/apiTransport";
import type { AIProgress } from "../src/editor/api";

afterEach(() => vi.unstubAllGlobals());

describe("request", () => {
  it("JSON リクエストの method / headers / body / signal を渡して JSON を返す", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetch);
    const ac = new AbortController();
    await expect(request("POST", "/test", { value: 1 }, ac.signal)).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith("/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: 1 }), signal: ac.signal });
  });

  it("body が未指定なら undefined のまま渡す", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await request("GET", "/test");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "GET", body: undefined });
  });

  it("HTTP error に error / code / status を付ける", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "no", code: "bad" }), { status: 422 })));
    await expect(request("GET", "/test")).rejects.toMatchObject({ message: "no", code: "bad", status: 422 });
  });

  it("JSON を読めない HTTP error はステータス由来の message にする", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid", { status: 500 })));
    await expect(request("GET", "/test")).rejects.toMatchObject({ message: "HTTP 500", status: 500 });
  });
});

function streamResponse(...chunks: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(body);
}

describe("postWithProgress", () => {
  it("チャンクをまたぐ NDJSON、空行、progress、result を処理する", async () => {
    const fetch = vi.fn(async () => streamResponse('{"progress":{"phase":"thinking","attempt":1}}\n\n{"res', 'ult":{"ok":true}}\n'));
    vi.stubGlobal("fetch", fetch);
    const progress: AIProgress[] = [];
    const ac = new AbortController();
    await expect(postWithProgress("/stream", { prompt: "hi" }, (p) => progress.push(p), ac.signal)).resolves.toEqual({ ok: true });
    expect(progress).toEqual([{ phase: "thinking", attempt: 1 }]);
    expect(fetch).toHaveBeenCalledWith("/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "hi" }), signal: ac.signal });
  });

  it("NDJSON error に error / code / status を付ける", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse('{"error":"failed","code":"oops","status":409}\n')));
    await expect(postWithProgress("/stream", {})).rejects.toMatchObject({ message: "failed", code: "oops", status: 409 });
  });

  it("途中切断時は従来のエラーを投げる", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse('{"progress":{"phase":"writing","attempt":2}}\n')));
    await expect(postWithProgress("/stream", {})).rejects.toThrow("サーバーからの応答が途中で切れました");
  });

  it("HTTP error は JSON の error / code / status を扱う", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "offline", code: "down" }), { status: 503 })));
    await expect(postWithProgress("/stream", {})).rejects.toMatchObject({ message: "offline", code: "down", status: 503 });
  });
});

describe("製品版（window.dcDesktop あり）", () => {
  const desktop = (res: unknown) => {
    const bridge = { request: vi.fn(async () => res) };
    vi.stubGlobal("window", { dcDesktop: bridge });
    return bridge;
  };

  it("operation に変換して IPC で呼び、data を返す（fetch は使わない）", async () => {
    const bridge = desktop({ ok: true, data: { posters: [] } });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(request("GET", "/api/posters")).resolves.toEqual({ posters: [] });
    expect(bridge.request).toHaveBeenCalledWith({ operation: "posters.list" });
    expect(fetch).not.toHaveBeenCalled();
    await request("PUT", "/api/posters/aaaaaaaaaaaa", { spec: 1 });
    expect(bridge.request).toHaveBeenLastCalledWith({ operation: "posters.update", params: { id: "aaaaaaaaaaaa" }, body: { spec: 1 } });
  });

  it("一覧に無い操作は DESKTOP_UNAVAILABLE", async () => {
    const bridge = desktop({ ok: true, data: {} });
    await expect(request("POST", "/api/asset", {})).rejects.toMatchObject({ code: "DESKTOP_UNAVAILABLE", status: 404, message: "Windows版ではこの機能は使えません" });
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it("ok:false は message / code / status を持つ Error にする", async () => {
    desktop({ ok: false, error: "no", code: "bad", status: 422 });
    await expect(request("GET", "/api/posters")).rejects.toMatchObject({ message: "no", code: "bad", status: 422 });
  });

  it("signal が中断済み・途中で中断されたら AbortError", async () => {
    const bridge = { request: vi.fn(() => new Promise(() => {})), cancel: vi.fn() };
    vi.stubGlobal("window", { dcDesktop: bridge });
    const done = new AbortController();
    done.abort();
    await expect(request("GET", "/api/posters", undefined, done.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(bridge.request).not.toHaveBeenCalled();
    const ac = new AbortController();
    const p = request("GET", "/api/posters", undefined, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("signal があるときだけ callId を付け、中断で cancel して AbortError", async () => {
    const bridge = { request: vi.fn(() => new Promise(() => {})), cancel: vi.fn() };
    vi.stubGlobal("window", { dcDesktop: bridge });
    void request("GET", "/api/posters").catch(() => {});
    expect(bridge.request.mock.calls[0]).toHaveLength(1);
    const ac = new AbortController();
    const p = request("GET", "/api/posters", undefined, ac.signal);
    const callId = (bridge.request.mock.calls[1] as unknown[])[1] as { callId: string };
    expect(callId.callId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(bridge.cancel).toHaveBeenCalledWith(callId.callId);
  });

  it("ABORTED の結果は AbortError", async () => {
    desktop({ ok: false, error: "中断しました", code: "ABORTED" });
    await expect(request("GET", "/api/posters")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("postWithProgress は onProgress を橋へ渡し result を返す", async () => {
    const p1: AIProgress = { phase: "writing", attempt: 1, chars: 5 };
    const bridge = {
      request: vi.fn(async (_req: unknown, opts?: { onProgress?: (p: AIProgress) => void }) => { opts?.onProgress?.(p1); return { ok: true, data: { spec: 1 } }; }),
      cancel: vi.fn(),
    };
    vi.stubGlobal("window", { dcDesktop: bridge });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const seen: AIProgress[] = [];
    await expect(postWithProgress("/api/reproduce", { a: 1 }, (p) => seen.push(p))).resolves.toEqual({ spec: 1 });
    expect(seen).toEqual([p1]);
    expect(bridge.request.mock.calls[0][0]).toMatchObject({ operation: "ai.reproduce", body: { a: 1 } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("postWithProgress の ok:false は message / code / status、ABORTED は AbortError", async () => {
    desktop({ ok: false, error: "no", code: "bad", status: 422 });
    await expect(postWithProgress("/api/reproduce", {})).rejects.toMatchObject({ message: "no", code: "bad", status: 422 });
    desktop({ ok: false, error: "中断しました", code: "ABORTED" });
    await expect(postWithProgress("/api/reproduce", {})).rejects.toMatchObject({ name: "AbortError" });
  });

  it("postWithProgress も対応付けできない URL は DESKTOP_UNAVAILABLE", async () => {
    const bridge = desktop({ ok: true, data: {} });
    await expect(postWithProgress("/api/asset", {})).rejects.toMatchObject({ code: "DESKTOP_UNAVAILABLE", status: 404 });
    expect(bridge.request).not.toHaveBeenCalled();
  });
});
