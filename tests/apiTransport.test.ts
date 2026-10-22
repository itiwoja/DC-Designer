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
