import { describe, expect, it, vi } from "vitest";
import { createAiConsentBroker } from "../desktop/aiConsent";
import { AI_DESTINATIONS, payloadHash, toAiImage, type AiConsentPayload } from "../desktop/aiPayload";
import type { MainToWorker } from "../desktop/protocol";
import { createRuntime, type WorkerChild } from "../desktop/runtime";

const payload = (text = "こんにちは"): AiConsentPayload => ({
  providerId: "chatgpt", endpoint: AI_DESTINATIONS.chatgpt.endpoint, model: "gpt-x", providerRouting: "direct",
  purpose: "レイアウトの生成", instructions: "指示",
  turns: [{ role: "user", text, images: [toAiImage("image/png", Buffer.from("png-bytes"))] }],
});

describe("createAiConsentBroker", () => {
  it.each([true, false])("画像あり=%s：確認窓や追加操作なしで検証済みの内容を送信できる", async (withImage) => {
    const broker = createAiConsentBroker();
    const p = payload();
    if (!withImage) delete p.turns[0].images;
    expect(await broker.request("r1", p)).toEqual({ decision: "approve", payloadHash: payloadHash(p) });
    expect(broker.stateOf("r1")).toBe("dispatching");
    broker.outcome("r1", "completed");
    expect(broker.stateOf("r1")).toBe("completed");
    // 終端から戻らず、同じ依頼は再送しない
    broker.outcome("r1", "failed");
    expect(broker.stateOf("r1")).toBe("completed");
    expect(await broker.request("r1", p)).toEqual({ decision: "invalid" });
  });

  it("画像のハッシュ・送信先・要求形式が不正なら送信を許可しない", async () => {
    const broker = createAiConsentBroker();
    const bad = payload();
    bad.turns[0].images![0].sha256 = "0".repeat(64);
    expect(await broker.request("r1", bad)).toEqual({ decision: "invalid" });
    expect(await broker.request("r2", { ...payload(), endpoint: "https://example.test/" })).toEqual({ decision: "invalid" });
    expect(await broker.request("r3", { nope: 1 })).toEqual({ decision: "invalid" });
    for (const id of ["", "r".repeat(101), 1, null]) {
      expect(await broker.request(id, payload())).toEqual({ decision: "invalid" });
    }
    expect(broker.stateOf("r1")).toBeUndefined();
  });

  it("複数のAI操作を確認待ちにせず、それぞれ1回だけ許可する", async () => {
    const broker = createAiConsentBroker();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => broker.request(`r${i}`, payload(`${i}`))));
    expect(results.every((r) => r.decision === "approve")).toBe(true);
    expect(new Set(results.map((r) => r.payloadHash)).size).toBe(10);
    expect(await broker.request("r1", payload("changed"))).toEqual({ decision: "invalid" });
  });

  it("subject は検証され、hash に含まれる", async () => {
    const broker = createAiConsentBroker();
    const subject = { kind: "deck" as const, id: "abcdefghij12", title: "四半期レビュー" };
    const result = await broker.request("r1", { ...payload(), subject });
    expect(result).toEqual({ decision: "approve", payloadHash: payloadHash({ ...payload(), subject }) });
    expect(result.payloadHash).not.toBe(payloadHash(payload()));
    for (const [i, bad] of [{ kind: "x", id: "abcdefghij12", title: "t" }, { kind: "poster", id: "ABC", title: "t" }, { kind: "poster", id: "abcdefghij12", title: "a".repeat(201) }, { kind: "poster", id: "abcdefghij12", title: 1 }, { kind: "poster", id: "abcdefghij12", title: "t", extra: 1 }, "poster", null].entries()) {
      expect(await broker.request(`bad${i}`, { ...payload(), subject: bad })).toEqual({ decision: "invalid" });
    }
  });

  it("worker が落ちたら送信中だけ結果不明にし、完了済みの結果は保つ", async () => {
    const broker = createAiConsentBroker();
    await broker.request("r1", payload());
    await broker.request("r2", payload());
    broker.outcome("r1", "completed");
    broker.reset();
    expect(broker.stateOf("r1")).toBe("completed");
    expect(broker.stateOf("r2")).toBe("outcomeUnknown");
    expect(await broker.request("r2", payload())).toEqual({ decision: "invalid" });
    broker.outcome("unknown", "completed");
    expect(broker.stateOf("unknown")).toBeUndefined();
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

describe("runtime の AI 送信検証の振り分け", () => {
  it("ai-consent を検証し、確認操作なしで ai-consent-result を返す。ai-outcome も渡す", async () => {
    const c = new FakeChild();
    const broker = createAiConsentBroker();
    const onAiConsent = vi.fn(broker.request);
    const onAiOutcome = vi.fn(broker.outcome);
    const rt = createRuntime({ appVersion: "1", onState: () => {}, fork: () => c, onAiConsent, onAiOutcome });
    rt.start();
    const p = payload();
    c.emit({ type: "ai-consent", requestId: "r1", payload: p });
    await tick();
    expect(onAiConsent).toHaveBeenCalledWith("r1", p);
    expect(c.sent.at(-1)).toEqual({ type: "ai-consent-result", requestId: "r1", decision: "approve", payloadHash: payloadHash(p) });
    c.emit({ type: "ai-outcome", requestId: "r1", outcome: "completed" });
    c.emit({ type: "ai-outcome", requestId: "r1", outcome: "bogus" });
    expect(onAiOutcome).toHaveBeenCalledTimes(1);
    expect(broker.stateOf("r1")).toBe("completed");
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
