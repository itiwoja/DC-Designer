import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloseCoordinator } from "../desktop/close";
import { API_PROTOCOL_VERSION, DESKTOP_TOKEN_HEADER } from "../desktop/protocol";
import type { MainToWorker } from "../desktop/protocol";
import { createSecretStore } from "../desktop/secrets";
import { buildWorkerEnv, createRuntime, initialRuntimeModel, reduceRuntime, type RuntimeEvent, type RuntimeModel, type WorkerChild } from "../desktop/runtime";

const run = (events: RuntimeEvent[], from: RuntimeModel = initialRuntimeModel) => events.reduce(reduceRuntime, from);

describe("reduceRuntime", () => {
  it("起動 → lease 待ち → ready → closing → ready", () => {
    expect(run([{ type: "lease-waiting" }]).state).toBe("waiting-lease");
    expect(run([{ type: "lease-waiting" }, { type: "ready" }]).state).toBe("ready");
    expect(run([{ type: "ready" }, { type: "closing" }]).state).toBe("closing");
    expect(run([{ type: "ready" }, { type: "closing" }, { type: "resume" }]).state).toBe("ready");
  });
  it("最初の失敗を残し、failed から start だけで戻る", () => {
    const f = run([{ type: "fail", error: "LEASE_TIMEOUT" }, { type: "fail", error: "WORKER_LOST" }, { type: "ready" }, { type: "closing" }]);
    expect(f).toEqual({ state: "failed", error: "LEASE_TIMEOUT" });
    expect(reduceRuntime(f, { type: "start" })).toEqual({ state: "starting" });
  });
  it("不正な遷移は状態を変えない", () => {
    expect(run([{ type: "closing" }]).state).toBe("starting");
    expect(run([{ type: "resume" }]).state).toBe("starting");
    expect(run([{ type: "ready" }, { type: "lease-waiting" }]).state).toBe("ready");
    expect(run([{ type: "start" }]).state).toBe("starting");
  });
  it("closing 中の失敗は failed になる", () => {
    expect(run([{ type: "ready" }, { type: "closing" }, { type: "fail", error: "WORKER_LOST" }]).state).toBe("failed");
  });
});

describe("buildWorkerEnv", () => {
  it("許可リストと保存先だけを渡す", () => {
    const env = buildWorkerEnv("/u/DC-Designer", { PATH: "p", TEMP: "t", OPENAI_API_KEY: "secret", NODE_OPTIONS: "--x", HTTPS_PROXY: "y" });
    expect(env).toMatchObject({ PATH: "p", TEMP: "t", DC_DESIGNER_DESKTOP: "1", DC_DESIGNER_USER_ROOT: "/u/DC-Designer" });
    expect(env.DATA_DIR).toMatch(/workspace$/);
    expect(env.GENERATED_DIR).toMatch(/generated$/);
    expect(env.DC_DESIGNER_CONFIG_DIR).toMatch(/secrets$/);
    expect(env.FONT_CACHE_DIR).toMatch(/fonts[\\/]cache$/);
    expect(Object.keys(env)).not.toContain("OPENAI_API_KEY");
    expect(Object.keys(env)).not.toContain("NODE_OPTIONS");
    expect(Object.keys(env)).not.toContain("HTTPS_PROXY");
  });
});

// ---- 偽の worker ----

class FakeChild implements WorkerChild {
  sent: MainToWorker[] = [];
  killed = false;
  private handlers: { message: ((m: unknown) => void)[]; exit: ((c: number) => void)[] } = { message: [], exit: [] };
  postMessage(m: MainToWorker) { this.sent.push(m); }
  on(ev: "message" | "exit", cb: never) { (this.handlers[ev] as unknown[]).push(cb); return this; }
  kill() { this.killed = true; queueMicrotask(() => this.exit()); return true; }
  emit(m: unknown) { this.handlers.message.forEach((h) => h(m)); }
  exit() { this.handlers.exit.forEach((h) => h(0)); }
  get init() { return this.sent.find((m) => m.type === "init") as Extract<MainToWorker, { type: "init" }>; }
}

function setup(health?: (init: { token: string; instanceId: string }) => unknown, secrets?: ReturnType<typeof createSecretStore>) {
  const children: FakeChild[] = [];
  const states: string[] = [];
  let last = { token: "", instanceId: "" };
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const h = init?.headers as Record<string, string>;
    if (u.endsWith("/api/desktop/health")) {
      last = { token: h[DESKTOP_TOKEN_HEADER], instanceId: children.at(-1)!.init.instanceId };
      return new Response(JSON.stringify(health ? health(last) : { instanceId: last.instanceId, apiProtocolVersion: API_PROTOCOL_VERSION, appVersion: "1.0.0", ready: true }));
    }
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  const rt = createRuntime({
    appVersion: "1.0.0",
    secrets,
    fetchImpl,
    onState: (s) => states.push(s.state + (s.error ? `:${s.error}` : "")),
    fork: () => { const c = new FakeChild(); children.push(c); return c; },
  });
  const readyMsg = (c: FakeChild, over: object = {}) => ({ type: "ready", port: 5555, instanceId: c.init.instanceId, apiProtocolVersion: API_PROTOCOL_VERSION, appVersion: "1.0.0", ...over });
  return { rt, children, states, fetchImpl, readyMsg };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createRuntime", () => {
  afterEach(() => vi.useRealTimers());

  it("init → ready → health 照合で ready。token は init でだけ渡す", async () => {
    const { rt, children, states, readyMsg } = setup();
    rt.start();
    const c = children[0];
    expect(c.init.token).toMatch(/^[0-9a-f]{64}$/);
    c.emit({ type: "lease-waiting" });
    expect(rt.snapshot().state).toBe("waiting-lease");
    c.emit(readyMsg(c));
    await tick();
    expect(rt.snapshot()).toEqual({ state: "ready", appVersion: "1.0.0" });
    expect(states).toEqual(["waiting-lease", "ready"]);
    expect(JSON.stringify(rt.snapshot())).not.toContain(c.init.token);
  });

  it("版違い・instanceId 違い・health 不一致を分類する", async () => {
    let s = setup();
    s.rt.start(); s.children[0].emit(s.readyMsg(s.children[0], { apiProtocolVersion: 99 })); await tick();
    expect(s.rt.snapshot().error).toBe("VERSION_MISMATCH");
    expect(s.children[0].killed).toBe(true);

    s = setup();
    s.rt.start(); s.children[0].emit(s.readyMsg(s.children[0], { instanceId: "other" })); await tick();
    expect(s.rt.snapshot().error).toBe("STARTUP_FAILED");

    s = setup((l) => ({ instanceId: "x", apiProtocolVersion: API_PROTOCOL_VERSION, appVersion: "1.0.0", ready: true, l }));
    s.rt.start(); s.children[0].emit(s.readyMsg(s.children[0])); await tick();
    expect(s.rt.snapshot().error).toBe("STARTUP_FAILED");

    s = setup((l) => ({ instanceId: l.instanceId, apiProtocolVersion: API_PROTOCOL_VERSION + 1, appVersion: "1.0.0", ready: true }));
    s.rt.start(); s.children[0].emit(s.readyMsg(s.children[0])); await tick();
    expect(s.rt.snapshot().error).toBe("VERSION_MISMATCH");
  });

  it("lease-failed・fatal・予期しない exit・30秒の超過", async () => {
    let s = setup();
    s.rt.start(); s.children[0].emit({ type: "lease-failed", reason: "timeout" });
    expect(s.rt.snapshot().error).toBe("LEASE_TIMEOUT");
    s = setup();
    s.rt.start(); s.children[0].emit({ type: "lease-failed", reason: "denied" });
    expect(s.rt.snapshot().error).toBe("LEASE_DENIED");

    s = setup();
    s.rt.start(); s.children[0].emit(s.readyMsg(s.children[0])); await tick();
    s.children[0].exit();
    expect(s.rt.snapshot()).toMatchObject({ state: "failed", error: "WORKER_LOST" });

    vi.useFakeTimers();
    s = setup();
    s.rt.start();
    vi.advanceTimersByTime(30_001);
    expect(s.rt.snapshot().error).toBe("STARTUP_FAILED");
  });

  it("retryStart は前の個体の exit 後に新 token・新 instanceId で起動する", async () => {
    const { rt, children } = setup();
    rt.start();
    children[0].emit({ type: "fatal", code: "INTERNAL" });
    expect(rt.snapshot().state).toBe("failed");
    const snap = await rt.retryStart();
    expect(snap.state).toBe("starting");
    expect(children).toHaveLength(2);
    expect(children[1].init.token).not.toBe(children[0].init.token);
    expect(children[1].init.instanceId).not.toBe(children[0].init.instanceId);
    // 古い個体の通知は無視する
    children[0].emit(children[0].init && { type: "lease-waiting" });
    expect(rt.snapshot().state).toBe("starting");
  });

  it("ready 以外では request を INVALID_STATE にし、ready では token と Origin を付けて中継する", async () => {
    const { rt, children, fetchImpl, readyMsg } = setup();
    const op = { method: "POST", route: "/api/x", maxBody: 10 } as const;
    rt.start();
    expect(await rt.request(op, "/api/x", undefined)).toMatchObject({ ok: false, code: "INVALID_STATE" });
    children[0].emit(readyMsg(children[0])); await tick();
    expect(await rt.request(op, "/api/x", { a: 1 })).toEqual({ ok: true, data: { ok: 1 } });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(url).toBe("http://127.0.0.1:5555/api/x");
    expect(init.redirect).toBe("error");
    expect(init.headers[DESKTOP_TOKEN_HEADER]).toBe(children[0].init.token);
    expect(init.headers.origin).toBe("app://dc-designer");
    expect(await rt.request(op, "/api/x", { a: "x".repeat(20) })).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
  });

  it("閉じる途中（closing）は新しい要求を断るが、閉じる前の確定保存（closeSave）だけは通す", async () => {
    const { rt, children, readyMsg } = setup();
    const op = { method: "POST", route: "/api/x", maxBody: 100 } as const;
    const save = { method: "PUT", route: "/api/posters/:id", maxBody: 100, closeSave: true } as const;
    rt.start();
    children[0].emit(readyMsg(children[0])); await tick();
    expect(rt.beginClosing()).toBe(true);
    expect(await rt.request(op, "/api/x", { a: 1 })).toMatchObject({ ok: false, code: "INVALID_STATE" });
    expect(await rt.request(save, "/api/posters/abcdefabcdef", { a: 1 })).toEqual({ ok: true, data: { ok: 1 } });
  });
});

describe("createCloseCoordinator", () => {
  function setupClose(opts: { prepare?: (id: string) => { allSaved: boolean; busy: boolean } | null; answers?: number[] } = {}) {
    const s = setup();
    s.rt.start();
    const c = s.children[0];
    c.emit(s.readyMsg(c));
    const answers = [...(opts.answers ?? [])];
    const dialogs: string[] = [];
    const finalize = vi.fn();
    const coord = createCloseCoordinator({
      runtime: s.rt,
      newId: (() => { let n = 0; return () => `req${++n}`; })(),
      sendPrepare: (id) => {
        const r = opts.prepare ? opts.prepare(id) : { allSaved: true, busy: false };
        if (r) queueMicrotask(() => coord.complete({ requestId: id, ...r }));
        return true;
      },
      choose: async (o) => { dialogs.push(o.message); return answers.shift() ?? 0; },
      finalize,
      sleep: async () => {},
      prepareTimeoutMs: 20,
    });
    // worker: drain → drained、shutdown → exit
    const origPost = c.postMessage.bind(c);
    c.postMessage = (m) => {
      origPost(m);
      if (m.type === "drain") queueMicrotask(() => c.emit({ type: "drained", requestId: m.requestId, busy: false }));
      if (m.type === "resume") queueMicrotask(() => c.emit({ type: "resumed", requestId: m.requestId }));
      if (m.type === "shutdown") queueMicrotask(() => c.exit());
    };
    return { ...s, c, coord, dialogs, finalize };
  }

  it("保存 → drain → shutdown → exit で閉じる", async () => {
    const t = await (async () => { const x = setupClose(); await tick(); return x; })();
    await t.coord.requestClose();
    expect(t.finalize).toHaveBeenCalledTimes(1);
    expect(t.c.sent.map((m) => m.type)).toEqual(["init", "drain", "shutdown"]);
    expect(t.dialogs).toEqual([]);
  });

  it("保存失敗・応答なしでは閉じず、resume して ready に戻す", async () => {
    let t = setupClose({ prepare: () => ({ allSaved: false, busy: false }) }); await tick();
    await t.coord.requestClose();
    expect(t.finalize).not.toHaveBeenCalled();
    expect(t.rt.snapshot().state).toBe("ready");
    expect(t.c.sent.some((m) => m.type === "resume")).toBe(true);

    t = setupClose({ prepare: () => null }); await tick();
    await t.coord.requestClose();
    expect(t.finalize).not.toHaveBeenCalled();
    expect(t.dialogs).toEqual(["閉じる操作を中止しました"]);
    expect(t.rt.snapshot().state).toBe("ready");
  });

  it("古い requestId の応答は無視する", async () => {
    const t = setupClose({ prepare: () => null }); await tick();
    t.coord.complete({ requestId: "stale", allSaved: true, busy: false });
    await t.coord.requestClose();
    expect(t.finalize).not.toHaveBeenCalled();
  });

  it("busy は初期ボタンが「編集へ戻る」。待つを選ぶと再確認する", async () => {
    let n = 0;
    const t = setupClose({ prepare: () => (++n === 1 ? { allSaved: true, busy: true } : { allSaved: true, busy: false }), answers: [1] }); await tick();
    await t.coord.requestClose();
    expect(t.dialogs).toEqual(["処理が実行中です"]);
    expect(t.finalize).toHaveBeenCalledTimes(1);
  });

  it("worker が失われているときは確認してから閉じる", async () => {
    const t = setupClose({ answers: [1] }); await tick();
    t.c.exit();
    await t.coord.requestClose();
    expect(t.dialogs).toEqual(["編集内容を保存できません"]);
    expect(t.finalize).toHaveBeenCalledTimes(1);
    const u = setupClose({ answers: [0] }); await tick();
    u.c.exit();
    await u.coord.requestClose();
    expect(u.finalize).not.toHaveBeenCalled();
  });
});

describe("資格情報の中継（EXE-API-006）", () => {
  const withStore = () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-secrets-"));
    const crypto = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(`enc:${v}`), decryptString: (b: Buffer) => b.toString().replace(/^enc:/, "") };
    const store = createSecretStore({ dir, crypto });
    return { dir, store, ...setup(undefined, store) };
  };
  const results = (c: FakeChild) => c.sent.filter((m) => m.type === "secret-result");

  it("init に状態一覧（値なし）を載せ、ChatGPT 操作の外では secret-get を拒否して値を返さない", () => {
    const t = withStore();
    t.store.set("openai", "apiKey", "sk-test");
    t.store.set("chatgpt", "oauth", '{"a":1}');
    t.rt.start();
    const c = t.children[0];
    expect(c.init.secretStates["openai/apiKey"]).toBe("configured");
    expect(JSON.stringify(c.init)).not.toContain("sk-test");
    c.emit({ type: "secret-get", requestId: "r1", providerId: "openai", kind: "apiKey" });
    c.emit({ type: "secret-get", requestId: "r2", providerId: "chatgpt", kind: "oauth" });
    c.emit({ type: "secret-get", requestId: "r3", providerId: "evil", kind: "apiKey" });
    expect(results(c)).toEqual([
      { type: "secret-result", requestId: "r1", ok: false, state: "unset", code: "SECRET_DENIED" },
      { type: "secret-result", requestId: "r2", ok: false, state: "unset", code: "SECRET_DENIED" },
      { type: "secret-result", requestId: "r3", ok: false, state: "unset", code: "SECRET_DENIED" },
    ]);
    expect(JSON.stringify(c.sent)).not.toContain("sk-test");
    rmSync(t.dir, { recursive: true, force: true });
  });

  it("不正なメッセージは無視する", () => {
    const t = withStore();
    t.rt.start();
    const c = t.children[0];
    const n = results(c).length;
    c.emit({ type: "secret-get", providerId: "openai", kind: "apiKey" }); // requestId なし
    c.emit({ type: "secret-get", requestId: 1, providerId: "openai", kind: "apiKey" });
    c.emit({ type: "secret-get", requestId: "x", providerId: 1, kind: "apiKey" });
    c.emit({ type: "secret-set", requestId: "x", providerId: "openai", kind: "apiKey", value: 5 });
    expect(results(c)).toHaveLength(n);
    rmSync(t.dir, { recursive: true, force: true });
  });

  it("ストアが無ければ何も答えない。状態変更は worker へ伝える", () => {
    const t = setup();
    t.rt.start();
    t.children[0].emit({ type: "secret-get", requestId: "r", providerId: "openai", kind: "apiKey" });
    expect(t.children[0].sent.filter((m) => m.type === "secret-result")).toEqual([]);
    t.rt.notifySecretChanged("openai/apiKey", "configured");
    expect(t.children[0].sent.at(-1)).toEqual({ type: "secret-changed", secretRef: "openai/apiKey", state: "configured" });
  });
});

describe("ChatGPT 操作の間だけ資格情報を渡す", () => {
  afterEach(() => vi.useRealTimers());

  const chatgptOp = { method: "POST", route: "/api/plan", maxBody: 1024, chatgpt: true } as const;
  const plainOp = { method: "POST", route: "/api/posters", maxBody: 1024 } as const;

  /** health だけ即答し、それ以外の fetch は resolve/reject を手で呼ぶまで待たせる */
  function setupGated(opts: { grace?: number; withCancel?: (id: string) => void } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "rt-chatgpt-"));
    const crypto = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(`enc:${v}`), decryptString: (b: Buffer) => b.toString().replace(/^enc:/, "") };
    const store = createSecretStore({ dir, crypto });
    store.set("chatgpt", "oauth", '{"tok":"x"}');
    store.set("openai", "apiKey", "sk-test");
    const children: FakeChild[] = [];
    const pending: { resolve: (r: Response) => void; reject: (e: unknown) => void; signal?: AbortSignal | null }[] = [];
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/desktop/health")) {
        return Promise.resolve(new Response(JSON.stringify({ instanceId: children.at(-1)!.init.instanceId, apiProtocolVersion: API_PROTOCOL_VERSION, appVersion: "1.0.0", ready: true })));
      }
      return new Promise<Response>((resolve, reject) => {
        pending.push({ resolve, reject, signal: init?.signal });
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const cancels: string[] = [];
    const rt = createRuntime({
      appVersion: "1.0.0", secrets: store, fetchImpl, onState: () => {},
      onAiConsentCancel: (id) => cancels.push(id),
      chatgptGraceMs: opts.grace ?? 0,
      fork: () => { const c = new FakeChild(); children.push(c); return c; },
    });
    return { dir, store, rt, children, pending, cancels };
  }
  async function ready(t: ReturnType<typeof setupGated>) {
    t.rt.start();
    const c = t.children[0];
    c.emit({ type: "ready", port: 5555, instanceId: c.init.instanceId, apiProtocolVersion: API_PROTOCOL_VERSION, appVersion: "1.0.0" });
    await tick();
    return c;
  }
  const lastResult = (c: FakeChild) => c.sent.filter((m) => m.type === "secret-result").at(-1);
  const get = (c: FakeChild, id: string, p = "chatgpt", k = "oauth") => c.emit({ type: "secret-get", requestId: id, providerId: p, kind: k });

  it("実行中は chatgpt/oauth の get/set/remove が通り、終わると再び拒否される", async () => {
    const t = setupGated();
    const c = await ready(t);
    get(c, "a");
    expect(lastResult(c)).toMatchObject({ ok: false, code: "SECRET_DENIED" });
    expect(lastResult(c)).not.toHaveProperty("value");

    const p = t.rt.request(chatgptOp, "/api/plan", { x: 1 });
    get(c, "b");
    expect(lastResult(c)).toEqual({ type: "secret-result", requestId: "b", ok: true, state: "configured", value: '{"tok":"x"}' });
    c.emit({ type: "secret-set", requestId: "c", providerId: "chatgpt", kind: "oauth", value: '{"tok":"y"}' });
    expect(t.store.get("chatgpt", "oauth").value).toBe('{"tok":"y"}');
    c.emit({ type: "secret-remove", requestId: "d", providerId: "chatgpt", kind: "oauth" });
    expect(t.store.get("chatgpt", "oauth").state).toBe("unset");
    // 他の provider は実行中でも拒否
    get(c, "e", "openai", "apiKey");
    expect(lastResult(c)).toMatchObject({ requestId: "e", ok: false, code: "SECRET_DENIED" });
    expect(JSON.stringify(c.sent)).not.toContain("sk-test");

    t.pending[0].resolve(new Response("{}", { status: 200 }));
    await p;
    c.emit({ type: "secret-set", requestId: "f", providerId: "chatgpt", kind: "oauth", value: "evil" });
    expect(lastResult(c)).toMatchObject({ requestId: "f", ok: false, code: "SECRET_DENIED" });
    expect(t.store.get("chatgpt", "oauth").state).toBe("unset");
    rmSync(t.dir, { recursive: true, force: true });
  });

  it("ChatGPT を使わない操作では開かない。複数並行は全部終わるまで開いたまま", async () => {
    const t = setupGated();
    const c = await ready(t);
    const plain = t.rt.request(plainOp, "/api/posters", {});
    get(c, "a");
    expect(lastResult(c)).toMatchObject({ ok: false, code: "SECRET_DENIED" });
    t.pending[0].resolve(new Response("{}")); await plain;

    const p1 = t.rt.request(chatgptOp, "/api/plan", {});
    const p2 = t.rt.request(chatgptOp, "/api/plan", {});
    t.pending[1].resolve(new Response("{}")); await p1;
    get(c, "b");
    expect(lastResult(c)).toMatchObject({ ok: true });
    t.pending[2].resolve(new Response("{}")); await p2;
    get(c, "c");
    expect(lastResult(c)).toMatchObject({ ok: false, code: "SECRET_DENIED" });
    rmSync(t.dir, { recursive: true, force: true });
  });

  it("失敗・中断でも閉じる（中断は猶予の後）", async () => {
    const t = setupGated({ grace: 1000 });
    const c = await ready(t);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pf = t.rt.request(chatgptOp, "/api/plan", {});
    t.pending[0].reject(new Error("net"));
    expect(await pf).toMatchObject({ ok: false });
    get(c, "a");
    expect(lastResult(c)).toMatchObject({ ok: false, code: "SECRET_DENIED" });

    const ac = new AbortController();
    const pa = t.rt.request(chatgptOp, "/api/plan", {}, { signal: ac.signal });
    ac.abort();
    expect(await pa).toMatchObject({ ok: false, code: "ABORTED" });
    get(c, "b"); // worker の後始末の間はまだ通る
    expect(lastResult(c)).toMatchObject({ ok: true });
    vi.advanceTimersByTime(1000);
    get(c, "d");
    expect(lastResult(c)).toMatchObject({ ok: false, code: "SECRET_DENIED" });
    rmSync(t.dir, { recursive: true, force: true });
  });

  it("ai-consent-cancel を onAiConsentCancel へ渡す（不正な requestId は無視）", async () => {
    const t = setupGated();
    const c = await ready(t);
    c.emit({ type: "ai-consent-cancel", requestId: "c-1" });
    c.emit({ type: "ai-consent-cancel", requestId: 5 });
    c.emit({ type: "ai-consent-cancel" });
    expect(t.cancels).toEqual(["c-1"]);
    rmSync(t.dir, { recursive: true, force: true });
  });
});
