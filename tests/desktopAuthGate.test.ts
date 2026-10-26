import http from "node:http";
import { describe, expect, it } from "vitest";
import type { DesktopResult } from "../desktop/bridge";
import { createAuthGate } from "../desktop/authGate";
import type { DesktopOperation } from "../desktop/operations";
import { matchDesktopOperation } from "../desktop/operations";

const authUrl = (state: string, host = "auth.openai.com") => `https://${host}/api/accounts/authorize?state=${state}&client_id=x`;

/** 偽の worker と偽のブラウザ。opened に開こうとした URL が溜まる */
function setup(opts: { complete?: (query: Record<string, string>) => unknown; start?: () => unknown; timeoutMs?: number } = {}) {
  const calls: { route: string; body: any }[] = [];
  const opened: string[] = [];
  let n = 0;
  const gate = createAuthGate({
    timeoutMs: opts.timeoutMs,
    request: async (op: DesktopOperation, path: string, body: unknown): Promise<DesktopResult> => {
      calls.push({ route: path, body });
      if (path === "/api/auth/chatgpt/start") return { ok: true, data: opts.start ? opts.start() : { url: authUrl(`s${++n}`) } };
      return { ok: true, data: opts.complete ? opts.complete((body as any).query) : { kind: "done", result: "signed-in" } };
    },
    openExternal: async (url) => { opened.push(url); },
  });
  return { gate, calls, opened };
}

const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); expect(f()).toBe(true); };
const portOf = (calls: { body: any }[]) => calls[0].body.port as number;
const get = (port: number, path: string, host = `127.0.0.1:${port}`) =>
  new Promise<{ status: number; body: string }>((ok, ng) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok({ status: res.statusCode!, body: b }));
    });
    req.on("error", ng); req.end();
  });
const refused = (port: number) => get(port, "/auth/callback").then(() => false, () => true);

describe("authGate", () => {
  it("正しい state のコールバックで完了し、受け口を閉じる", async () => {
    const { gate, calls, opened } = setup();
    const p = gate.signIn();
    await until(() => opened.length === 1);
    const port = portOf(calls);
    expect(port).toBeGreaterThanOrEqual(1024);
    const res = await get(port, "/auth/callback?state=s1&code=abc&extra=zzz");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("abc");
    expect(await p).toEqual({ ok: true, data: { result: "signed-in" } });
    expect(calls[1]).toEqual({ route: "/api/auth/chatgpt/complete", body: { query: { state: "s1", code: "abc" } } });
    expect(await refused(port)).toBe(true);
  });

  it("state 不一致・別 path・別 Host は worker へ渡さない", async () => {
    const { gate, calls, opened } = setup();
    const p = gate.signIn({ newAccount: true });
    await until(() => opened.length === 1);
    const port = portOf(calls);
    expect(calls[0].body.newAccount).toBe(true);
    expect((await get(port, "/auth/callback?state=bad&code=x")).status).toBe(400);
    expect((await get(port, "/other?state=s1")).status).toBe(404);
    expect((await get(port, "/auth/callback?state=s1&code=x", "localhost:" + port)).status).toBe(400);
    expect(calls).toHaveLength(1);
    await get(port, "/auth/callback?state=s1&code=x");
    expect((await p).ok).toBe(true);
  });

  it("許可外ホストの URL は開かない", async () => {
    const { gate, opened } = setup({ start: () => ({ url: authUrl("s1", "evil.example") }) });
    const r = await gate.signIn();
    expect(r.ok).toBe(false);
    expect(opened).toEqual([]);
    const { gate: g2, opened: o2 } = setup({ start: () => ({ url: "http://auth.openai.com/x?state=s" }) });
    expect((await g2.signIn()).ok).toBe(false);
    expect(o2).toEqual([]);
  });

  it("retry は1回だけ開き直す", async () => {
    let step = 0;
    const { gate, calls, opened } = setup({ complete: () => (++step === 1 ? { kind: "retry", url: authUrl("r1") } : { kind: "retry", url: authUrl("r2") }) });
    const p = gate.signIn();
    await until(() => opened.length === 1);
    const port = portOf(calls);
    await get(port, "/auth/callback?state=s1&code=x");
    await until(() => opened.length === 2);
    expect(opened[1]).toBe(authUrl("r1"));
    expect((await get(port, "/auth/callback?state=s1&code=x")).status).toBe(400); // 古い state
    await get(port, "/auth/callback?state=r1&code=y");
    const r = await p;
    expect(r.ok).toBe(false);
    expect(opened).toHaveLength(2);
  });

  it("retry の URL も許可外なら開かない", async () => {
    const { gate, calls, opened } = setup({ complete: () => ({ kind: "retry", url: authUrl("r1", "evil.example") }) });
    const p = gate.signIn();
    await until(() => opened.length === 1);
    await get(portOf(calls), "/auth/callback?state=s1&code=x");
    expect((await p).ok).toBe(false);
    expect(opened).toHaveLength(1);
  });

  it("worker の error を利用者向けの失敗にする", async () => {
    const { gate, calls, opened } = setup({ complete: () => ({ kind: "error", message: "サインインがキャンセルされました" }) });
    const p = gate.signIn();
    await until(() => opened.length === 1);
    await get(portOf(calls), "/auth/callback?state=s1&error=access_denied");
    expect(await p).toEqual({ ok: false, error: "サインインがキャンセルされました", code: "AUTH_FAILED" });
  });

  it("期限切れで失敗し、受け口を閉じる", async () => {
    const { gate, calls } = setup({ timeoutMs: 30 });
    const r = await gate.signIn();
    expect(r).toMatchObject({ ok: false, code: "AUTH_TIMEOUT" });
    expect(await refused(portOf(calls))).toBe(true);
  });

  it("同時のサインインは同じ結果を待ち、終われば次を始められる", async () => {
    const { gate, calls, opened } = setup();
    const a = gate.signIn();
    const b = gate.signIn();
    expect(b).toBe(a);
    await until(() => opened.length === 1);
    await get(portOf(calls), "/auth/callback?state=s1&code=x");
    await a;
    const c = gate.signIn();
    expect(c).not.toBe(a);
    await until(() => opened.length === 2);
    await get(calls[2].body.port, "/auth/callback?state=s2&code=x");
    expect((await c).ok).toBe(true);
  });
});

describe("operations", () => {
  it("画面の logout は auth.logout になり、start/complete は画面から引けない", () => {
    expect(matchDesktopOperation("POST", "/api/auth/chatgpt/logout")).toEqual({ operation: "auth.logout" });
    expect(matchDesktopOperation("POST", "/api/auth/chatgpt/start")).toBeNull();
    expect(matchDesktopOperation("POST", "/api/auth/chatgpt/complete")).toBeNull();
  });
});
