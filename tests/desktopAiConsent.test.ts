import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiConsentBroker, type AiConsentState, type ConsentView, type ConsentWindowHandle } from "../desktop/aiConsent";
import { AI_CONSENT_TTL_MS, AI_DESTINATIONS, toAiImage, type AiConsentPayload } from "../desktop/aiPayload";
import type { MainToWorker } from "../desktop/protocol";
import { createRuntime, type WorkerChild } from "../desktop/runtime";

const payload = (text = "こんにちは"): AiConsentPayload => ({
  providerId: "chatgpt", endpoint: AI_DESTINATIONS.chatgpt.endpoint, model: "gpt-x", providerRouting: "direct",
  purpose: "レイアウトの生成", instructions: "指示",
  turns: [{ role: "user", text, images: [toAiImage("image/png", Buffer.from("png-bytes"))] }],
});

type FakeWin = ConsentWindowHandle & { view: ConsentView; closed: boolean; outcomes: string[] };
function setup() {
  const wins: FakeWin[] = [];
  const log: string[] = [];
  let sid = 10;
  const broker = createAiConsentBroker({
    now: () => Date.now(),
    openWindow: (view) => {
      const w: FakeWin = {
        view, senderId: ++sid, closed: false, outcomes: [],
        close() { w.closed = true; },
        showOutcome(o) { w.outcomes.push(o); },
      };
      wins.push(w);
      return w;
    },
    onTransition: (x) => log.push(`${x.requestId}:${x.from}>${x.to}`),
  });
  return { broker, wins, log };
}
const approve = (w: FakeWin, over: Record<string, unknown> = {}) =>
  ({ requestId: w.view.requestId, payloadHash: w.view.payloadHash, decision: "approve", ...over });

describe("createAiConsentBroker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("検証に通った依頼を確認窓に出し、承認は1回だけ成立する", async () => {
    const { broker, wins } = setup();
    const p = broker.request("r1", payload());
    expect(wins).toHaveLength(1);
    const w = wins[0];
    expect(broker.decide(w.senderId, approve(w))).toBe(true);
    expect(await p).toEqual({ decision: "approve", payloadHash: w.view.payloadHash });
    expect(broker.stateOf("r1")).toBe("dispatching");
    expect(w.outcomes).toEqual(["sending"]);
    // 重複の承認は無効
    expect(broker.decide(w.senderId, approve(w))).toBe(false);
    broker.outcome("r1", "completed");
    expect(broker.stateOf("r1")).toBe("completed");
    expect(w.outcomes).toEqual(["sending", "completed"]);
    // 終端から戻らない
    broker.outcome("r1", "failed");
    expect(broker.stateOf("r1")).toBe("completed");
  });

  it("画像の bytes とハッシュが合わない・形が不正・重複 requestId は invalid で窓を出さない", async () => {
    const { broker, wins } = setup();
    const bad = payload();
    bad.turns[0].images![0].sha256 = "0".repeat(64);
    expect(await broker.request("r1", bad)).toEqual({ decision: "invalid" });
    expect(await broker.request("r2", { nope: 1 })).toEqual({ decision: "invalid" });
    expect(await broker.request("", payload())).toEqual({ decision: "invalid" });
    expect(wins).toHaveLength(0);
    void broker.request("r3", payload());
    expect(await broker.request("r3", payload())).toEqual({ decision: "invalid" });
  });

  it("別 sender・requestId 違い・ハッシュ不一致の承認は拒否され、状態は prepared のまま", () => {
    const { broker, wins } = setup();
    void broker.request("r1", payload());
    const w = wins[0];
    expect(broker.decide(w.senderId + 1, approve(w))).toBe(false);
    expect(broker.decide(w.senderId, approve(w, { payloadHash: "x" }))).toBe(false);
    expect(broker.decide(w.senderId, approve(w, { requestId: "r9" }))).toBe(false);
    expect(broker.decide(w.senderId, approve(w, { decision: "send" }))).toBe(false);
    expect(broker.stateOf("r1")).toBe("prepared");
  });

  it("「送信しない」・窓を閉じる・Esc は拒否", async () => {
    const { broker, wins } = setup();
    const a = broker.request("r1", payload());
    expect(broker.decide(wins[0].senderId, approve(wins[0], { decision: "deny" }))).toBe(true);
    expect(await a).toEqual({ decision: "deny" });
    expect(wins[0].closed).toBe(true);
    const b = broker.request("r2", payload());
    broker.windowClosed("r2");
    expect(await b).toEqual({ decision: "deny" });
    expect(broker.stateOf("r2")).toBe("denied");
    // 承認後に窓が閉じても状態は変わらない
    const c = broker.request("r3", payload());
    broker.decide(wins[2].senderId, approve(wins[2]));
    await c;
    broker.windowClosed("r3");
    expect(broker.stateOf("r3")).toBe("dispatching");
  });

  it("期限切れは expired。期限後の承認は通らない", async () => {
    const { broker, wins } = setup();
    const a = broker.request("r1", payload());
    vi.setSystemTime(Date.now() + AI_CONSENT_TTL_MS - 1);
    vi.setSystemTime(Date.now() + 2);
    // タイマー前に承認が来ても期限を見て拒否
    expect(broker.decide(wins[0].senderId, approve(wins[0]))).toBe(false);
    expect(await a).toEqual({ decision: "expired" });
    expect(broker.stateOf("r1")).toBe("expired");
    expect(wins[0].closed).toBe(true);
  });

  it("タイマーでも期限切れになる", async () => {
    const { broker } = setup();
    const a = broker.request("r1", payload());
    vi.advanceTimersByTime(AI_CONSENT_TTL_MS);
    expect(await a).toEqual({ decision: "expired" });
  });

  it("複数の依頼は1つずつ順に出す。待っている間にも期限は進む", async () => {
    const { broker, wins } = setup();
    const a = broker.request("r1", payload("a"));
    const b = broker.request("r2", payload("b"));
    expect(wins).toHaveLength(1);
    broker.decide(wins[0].senderId, approve(wins[0], { decision: "deny" }));
    await a;
    expect(wins).toHaveLength(2);
    expect(wins[1].view.requestId).toBe("r2");
    // 待ち行列中の依頼は窓から決定できない
    const c = broker.request("r3", payload("c"));
    expect(broker.decide(wins[1].senderId, { requestId: "r3", payloadHash: "x", decision: "approve" })).toBe(false);
    broker.decide(wins[1].senderId, approve(wins[1]));
    expect(await b).toMatchObject({ decision: "approve" });
    expect(wins).toHaveLength(3); // 承認後に次の窓
    vi.advanceTimersByTime(AI_CONSENT_TTL_MS);
    expect(await c).toEqual({ decision: "expired" });
  });

  it("reset で保留は invalidated、送信中は outcomeUnknown", async () => {
    const { broker, wins } = setup();
    const a = broker.request("r1", payload());
    broker.decide(wins[0].senderId, approve(wins[0]));
    await a;
    const b = broker.request("r2", payload());
    const c = broker.request("r3", payload());
    broker.reset();
    expect(await b).toEqual({ decision: "invalid" });
    expect(await c).toEqual({ decision: "invalid" });
    expect(broker.stateOf("r1")).toBe("outcomeUnknown");
    expect(broker.stateOf("r2")).toBe("invalidated");
    expect(broker.stateOf("r3")).toBe("invalidated");
  });

  it("窓を開けなければ invalid、遷移は記録される", async () => {
    const log: AiConsentState[] = [];
    const broker = createAiConsentBroker({ now: Date.now, openWindow: () => { throw new Error("x"); }, onTransition: (t) => log.push(t.to) });
    expect(await broker.request("r1", payload())).toEqual({ decision: "invalid" });
    expect(log).toEqual(["prepared", "invalidated"]);
  });
});

// ---- runtime の振り分け ----

class FakeChild implements WorkerChild {
  sent: MainToWorker[] = [];
  private h: { message: ((m: unknown) => void)[]; exit: ((c: number) => void)[] } = { message: [], exit: [] };
  postMessage(m: MainToWorker) { this.sent.push(m); }
  on(ev: "message" | "exit", cb: never) { (this.h[ev] as unknown[]).push(cb); return this; }
  kill() { queueMicrotask(() => this.exit()); return true; }
  emit(m: unknown) { this.h.message.forEach((f) => f(m)); }
  exit() { this.h.exit.forEach((f) => f(0)); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("runtime の AI 送信確認の振り分け", () => {
  it("ai-consent を deps へ渡し、結果を ai-consent-result で返す。ai-outcome も渡す", async () => {
    const c = new FakeChild();
    const onAiConsent = vi.fn(async () => ({ decision: "approve" as const, payloadHash: "h" }));
    const onAiOutcome = vi.fn();
    const rt = createRuntime({ appVersion: "1", onState: () => {}, fork: () => c, onAiConsent, onAiOutcome });
    rt.start();
    c.emit({ type: "ai-consent", requestId: "r1", payload: { a: 1 } });
    await tick();
    expect(onAiConsent).toHaveBeenCalledWith("r1", { a: 1 });
    expect(c.sent.at(-1)).toEqual({ type: "ai-consent-result", requestId: "r1", decision: "approve", payloadHash: "h" });
    c.emit({ type: "ai-outcome", requestId: "r1", outcome: "completed" });
    c.emit({ type: "ai-outcome", requestId: "r1", outcome: "bogus" });
    expect(onAiOutcome).toHaveBeenCalledTimes(1);
    expect(onAiOutcome).toHaveBeenCalledWith("r1", "completed");
  });

  it("deps が無い・例外なら invalid。worker が落ちたら onAiWorkerLost と返事の破棄", async () => {
    const c = new FakeChild();
    const rt = createRuntime({ appVersion: "1", onState: () => {}, fork: () => c });
    rt.start();
    c.emit({ type: "ai-consent", requestId: "r1", payload: {} });
    await tick();
    expect(c.sent.at(-1)).toEqual({ type: "ai-consent-result", requestId: "r1", decision: "invalid" });

    const c2 = new FakeChild();
    let release: (d: { decision: "approve"; payloadHash: string }) => void = () => {};
    const lost = vi.fn();
    const rt2 = createRuntime({
      appVersion: "1", onState: () => {}, fork: () => c2, onAiWorkerLost: lost,
      onAiConsent: () => new Promise((r) => { release = r; }),
    });
    rt2.start();
    c2.emit({ type: "ai-consent", requestId: "r2", payload: {} });
    c2.exit();
    expect(lost).toHaveBeenCalled();
    release({ decision: "approve", payloadHash: "h" });
    await tick();
    expect(c2.sent.some((m) => m.type === "ai-consent-result")).toBe(false);
  });
});
