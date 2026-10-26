import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloseCoordinator } from "../desktop/close";
import { DESKTOP_OPERATIONS, type DesktopOperation } from "../desktop/operations";
import { API_PROTOCOL_VERSION, DESKTOP_TOKEN_HEADER } from "../desktop/protocol";
import type { MainToWorker } from "../desktop/protocol";
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

function setup(health?: (init: { token: string; instanceId: string }) => unknown) {
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

    s = setup((l) => ({ instanceId: l.instanceId, apiProtocolVersion: 2, appVersion: "1.0.0", ready: true }));
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
});

describe("終了前の確定保存", () => {
  it("実際の操作一覧のうち作品の新規保存・更新だけを closing 中に中継する", async () => {
    const { rt, children, fetchImpl, readyMsg } = setup();
    rt.start();
    for (const name of ["posters.create", "posters.update"] as const) {
      expect(await rt.request(DESKTOP_OPERATIONS[name], "/api/posters/abcdefabcdef", {})).toMatchObject({ ok: false, code: "INVALID_STATE" });
    }
    children[0].emit(readyMsg(children[0])); await tick();
    expect(rt.beginClosing()).toBe(true);
    for (const [name, op] of Object.entries(DESKTOP_OPERATIONS) as [string, DesktopOperation][]) {
      const path = op.route.replace(/:[a-zA-Z]+/g, "abcdefabcdef");
      const result = await rt.request(op, path, op.maxBody ? {} : undefined);
      if (name === "posters.create" || name === "posters.update") {
        expect(result).toEqual({ ok: true, data: { ok: 1 } });
      } else {
        expect(result).toMatchObject({ ok: false, code: "INVALID_STATE" });
      }
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3); // health と保存2回だけ
    children[0].exit();
    expect(await rt.request(DESKTOP_OPERATIONS["posters.update"], "/api/posters/abcdefabcdef", {})).toMatchObject({ ok: false, code: "INVALID_STATE" });
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
