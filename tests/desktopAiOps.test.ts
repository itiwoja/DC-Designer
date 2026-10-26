import { describe, expect, it, vi } from "vitest";
import { createCallRegistry, parseCallOptions } from "../desktop/callRegistry";
import type { DesktopProgress } from "../desktop/bridge";
import { DESKTOP_OPERATIONS, matchDesktopOperation, resolveDesktopRequest } from "../desktop/operations";
import { API_PROTOCOL_VERSION } from "../desktop/protocol";
import type { MainToWorker } from "../desktop/protocol";
import { createRuntime, type WorkerChild } from "../desktop/runtime";

describe("AI 操作の操作表", () => {
  const table: [string, string, string, number, boolean][] = [
    ["ai.plan", "POST", "/api/plan", 40, false],
    ["ai.planInstagram", "POST", "/api/plan/instagram", 40, true],
    ["ai.reproduce", "POST", "/api/reproduce", 40, true],
    ["ai.reproduceRefine", "POST", "/api/reproduce/refine", 40, true],
    ["ai.edit", "POST", "/api/edit", 40, false],
    ["ai.slide", "POST", "/api/slide", 40, false],
    ["ai.notes", "POST", "/api/notes", 4, false],
    ["ai.summarize", "POST", "/api/chat/summarize", 1, false],
    ["fonts.suggest", "POST", "/api/fonts/suggest", 1, false],
  ];
  it("名前・method・route・上限・stream が約束どおりで、解決できる", () => {
    for (const [name, method, route, mb, stream] of table) {
      const op = DESKTOP_OPERATIONS[name as keyof typeof DESKTOP_OPERATIONS] as { method: string; route: string; maxBody: number; stream?: true };
      expect(op).toMatchObject({ method, route, maxBody: mb * 1024 * 1024 });
      expect(op.stream === true).toBe(stream);
      expect(matchDesktopOperation(method, route)).toEqual({ operation: name });
      expect(resolveDesktopRequest({ operation: name, body: {} })?.path).toBe(route);
    }
    expect(DESKTOP_OPERATIONS["chatgpt.model"]).toMatchObject({ method: "PUT", route: "/api/chatgpt/model", maxBody: 1024 });
    expect(matchDesktopOperation("PUT", "/api/chatgpt/model")).toEqual({ operation: "chatgpt.model" });
  });
  it("/api/asset は解決できない", () => {
    expect(matchDesktopOperation("POST", "/api/asset")).toBeNull();
    expect(resolveDesktopRequest({ operation: "ai.asset" })).toBeNull();
    expect(resolveDesktopRequest({ operation: "asset.create" })).toBeNull();
  });
});

describe("callRegistry", () => {
  it("callId の形を検証する", () => {
    expect(parseCallOptions(undefined)).toEqual({});
    expect(parseCallOptions({ callId: "abcd-1234" })).toEqual({ callId: "abcd-1234" });
    for (const v of [null, "x", [], { callId: "short" }, { callId: "a/b/c/d/e/f" }, { callId: 1 }, { callId: "abcd1234", x: 1 }, { callId: "a".repeat(65) }]) {
      expect(parseCallOptions(v)).toBeNull();
    }
  });
  it("重複は拒否し、sender が違えば中断できず、終わったら消える", () => {
    const reg = createCallRegistry();
    const ac = reg.begin(1, "call-0001")!;
    expect(reg.begin(1, "call-0001")).toBeNull();
    expect(reg.begin(2, "call-0001")).not.toBeNull();
    expect(reg.cancel(3, "call-0001")).toBe(false);
    expect(ac.signal.aborted).toBe(false);
    expect(reg.cancel(1, "call-0001")).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    reg.end(1, "call-0001", ac);
    expect(reg.cancel(1, "call-0001")).toBe(false);
    expect(reg.cancel(1, 5)).toBe(false);
    expect(reg.size()).toBe(1);
  });
});

// ---- runtime.request の stream ----

class FakeChild implements WorkerChild {
  sent: MainToWorker[] = [];
  private handlers: { message: ((m: unknown) => void)[]; exit: ((c: number) => void)[] } = { message: [], exit: [] };
  postMessage(m: MainToWorker) { this.sent.push(m); }
  on(ev: "message" | "exit", cb: never) { (this.handlers[ev] as unknown[]).push(cb); return this; }
  kill() { return true; }
  emit(m: unknown) { this.handlers.message.forEach((h) => h(m)); }
}

async function ready(api: (init: RequestInit | undefined) => Response | Promise<Response>) {
  const children: FakeChild[] = [];
  let instanceId = "";
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/api/desktop/health")) {
      return new Response(JSON.stringify({ instanceId, apiProtocolVersion: API_PROTOCOL_VERSION, appVersion: "1.0.0", ready: true }));
    }
    return api(init);
  }) as unknown as typeof fetch;
  const rt = createRuntime({ appVersion: "1.0.0", fetchImpl, onState: () => {}, fork: () => { const c = new FakeChild(); children.push(c); return c; } });
  rt.start();
  const c = children[0];
  instanceId = (c.sent.find((m) => m.type === "init") as Extract<MainToWorker, { type: "init" }>).instanceId;
  c.emit({ type: "ready", port: 5555, instanceId, apiProtocolVersion: API_PROTOCOL_VERSION, appVersion: "1.0.0" });
  await new Promise((r) => setTimeout(r, 0));
  return rt;
}

const streamOp = DESKTOP_OPERATIONS["ai.reproduce"];
const plainOp = DESKTOP_OPERATIONS["ai.plan"];
const enc = new TextEncoder();
const streamOf = (chunks: string[]) =>
  new Response(new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }), { status: 200 });

describe("runtime.request の stream", () => {
  it("チャンクをまたぐ行・空行を扱い、progress の余計な項目を落として result を返す", async () => {
    const rt = await ready(() => streamOf([
      '{"progress":{"phase":"thin', 'king","attempt":1,"extra":"x"}}\n\n{"progress":{"phase":"writing","attempt":2,"chars":10,"items":"a","secret":1}}\n{"prog',
      'ress":{"phase":"bad","attempt":1}}\n{"progress":{"phase":"writing","attempt":1.5}}\n{"result":{"a":1}}\n',
    ]));
    const got: DesktopProgress[] = [];
    const r = await rt.request(streamOp, "/api/reproduce", {}, { onProgress: (p) => got.push(p) });
    expect(r).toEqual({ ok: true, data: { a: 1 } });
    expect(got).toEqual([{ phase: "thinking", attempt: 1 }, { phase: "writing", attempt: 2, chars: 10 }]);
  });
  it("error 行は error・code・status を渡す（error は500文字まで、型違いの項目は落とす）", async () => {
    let rt = await ready(() => streamOf([`{"error":"${"あ".repeat(600)}","code":"X","status":429}\n`]));
    let r = await rt.request(streamOp, "/api/reproduce", {});
    expect(r).toEqual({ ok: false, error: "あ".repeat(500), code: "X", status: 429 });
    rt = await ready(() => streamOf(['{"error":"e","code":5,"status":"x"}\n']));
    r = await rt.request(streamOp, "/api/reproduce", {});
    expect(r).toEqual({ ok: false, error: "e" });
  });
  it("result も error も無く終わると WORKER_LOST。末尾に改行が無い result 行も読む", async () => {
    let rt = await ready(() => streamOf(['{"progress":{"phase":"thinking","attempt":1}}\n']));
    expect(await rt.request(streamOp, "/api/reproduce", {})).toEqual({ ok: false, error: "応答が途中で切れました", code: "WORKER_LOST" });
    rt = await ready(() => streamOf(['{"result":1}']));
    expect(await rt.request(streamOp, "/api/reproduce", {})).toEqual({ ok: true, data: 1 });
  });
  it("壊れた行・大きすぎる行は失敗にする", async () => {
    let rt = await ready(() => streamOf(["not json\n"]));
    expect(await rt.request(streamOp, "/api/reproduce", {})).toMatchObject({ ok: false, code: "WORKER_LOST" });
    rt = await ready(() => streamOf([`{"progress":{"phase":"thinking","attempt":1},"pad":"${"x".repeat(70_000)}"}\n`]));
    expect(await rt.request(streamOp, "/api/reproduce", {})).toMatchObject({ ok: false, code: "WORKER_LOST" });
  });
  it("HTTP が 2xx でなければ従来どおり JSON のエラー", async () => {
    const rt = await ready(() => new Response(JSON.stringify({ error: "no", code: "C" }), { status: 400 }));
    expect(await rt.request(streamOp, "/api/reproduce", {})).toEqual({ ok: false, error: "no", code: "C", status: 400 });
  });
  it("中断すると ABORTED（開始前・fetch 中・読み取り中）", async () => {
    const rt0 = await ready(() => streamOf(['{"result":1}\n']));
    const pre = new AbortController(); pre.abort();
    expect(await rt0.request(streamOp, "/api/reproduce", {}, { signal: pre.signal })).toMatchObject({ code: "ABORTED", error: "中断しました" });

    const ac = new AbortController();
    const rt = await ready((init) => new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError")))));
    const p = rt.request(plainOp, "/api/plan", {}, { signal: ac.signal });
    ac.abort();
    expect(await p).toMatchObject({ ok: false, code: "ABORTED" });

    const ac2 = new AbortController();
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const rt2 = await ready(() => new Response(new ReadableStream<Uint8Array>({ start(c) { ctl = c; } })));
    const p2 = rt2.request(streamOp, "/api/reproduce", {}, { signal: ac2.signal });
    await new Promise((r) => setTimeout(r, 0));
    ctl.enqueue(enc.encode('{"progress":{"phase":"thinking","attempt":1}}\n'));
    await new Promise((r) => setTimeout(r, 0));
    ac2.abort();
    ctl.enqueue(enc.encode("\n"));
    expect(await p2).toMatchObject({ ok: false, code: "ABORTED" });
  });
  it("stream でない操作は従来どおり本文全体を JSON として返す", async () => {
    const rt = await ready(() => new Response(JSON.stringify({ plan: 1 }), { status: 200 }));
    const onProgress = vi.fn();
    expect(await rt.request(plainOp, "/api/plan", {}, { onProgress })).toEqual({ ok: true, data: { plan: 1 } });
    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe("ChatGPT の資格情報を使う操作の印", () => {
  it("authStatus / getAccessToken / listModels / askChatGPT を呼ぶ操作と、サインインの内部操作だけに付く", async () => {
    const { DESKTOP_INTERNAL_OPERATIONS } = await import("../desktop/operations");
    const all = { ...DESKTOP_OPERATIONS, ...DESKTOP_INTERNAL_OPERATIONS } as Record<string, { chatgpt?: true }>;
    const marked = Object.keys(all).filter((k) => all[k].chatgpt).sort();
    expect(marked).toEqual([
      "ai.edit", "ai.notes", "ai.plan", "ai.planInstagram", "ai.reproduce", "ai.reproduceRefine", "ai.slide", "ai.summarize",
      "auth.complete", "auth.logout", "auth.start", "chatgpt.model", "fonts.suggest", "status.get",
    ]);
  });
});
