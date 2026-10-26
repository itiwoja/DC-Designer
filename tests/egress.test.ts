import { afterEach, describe, expect, it, vi } from "vitest";
import { createEgressGate, EGRESS_PERMIT_TTL_MS, EgressDeniedError, installEgress, uninstallEgressForTest } from "../server/egress";
import { JWKS_URL, REVOKE_URL, TOKEN_URL } from "../server/chatgpt-auth";
import { googleCssUrl } from "../src/fonts";

function setup() {
  let t = 1_000;
  const real = vi.fn(async (_i: unknown, _init?: RequestInit) => new Response("ok"));
  const gate = createEgressGate(real as unknown as typeof fetch, { now: () => t });
  return { real, gate, advance: (ms: number) => { t += ms; } };
}
const denied = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(EgressDeniedError);

describe("egress ゲート", () => {
  it("許可表の auth は chatgpt-auth.ts の URL と一致する", async () => {
    const { gate, real } = setup();
    await gate.fetch(JWKS_URL);
    await gate.fetch(TOKEN_URL, { method: "POST" });
    await gate.fetch(REVOKE_URL, { method: "POST" });
    expect(real).toHaveBeenCalledTimes(3);
    await denied(gate.fetch(TOKEN_URL)); // method 違い
    await denied(gate.fetch(JWKS_URL, { method: "POST" }));
  });

  it("fonts：Google Fonts の CSS と実体の GET だけ通す", async () => {
    const { gate, real } = setup();
    await gate.fetch(googleCssUrl("Noto Sans JP"));
    await gate.fetch("https://fonts.gstatic.com/s/notosansjp/v1/a.ttf", { redirect: "manual" });
    expect(real).toHaveBeenCalledTimes(2);
    await denied(gate.fetch(googleCssUrl("Noto Sans JP"), { method: "POST" }));
    await denied(gate.fetch("https://fonts.googleapis.com/other"));
    await denied(gate.fetch("https://fonts.gstatic.com/x"));
  });

  it("許可外のホスト・http・資格情報つき・別ポート・不正な URL・許可外 path/method は送らずに拒否する", async () => {
    const { gate, real } = setup();
    for (const u of [
      "https://example.com/", "http://api.openai.com/v1/models", "https://user:pw@api.openai.com/v1/models", "https://api.openai.com:8443/v1/models",
      "https://api.openai.com/v1/models/x", "https://api.openai.com/v1/files", "https://api.openai.com/v1/models?x=1", "https://api.openai.com.evil.test/v1/models",
      "https://openrouter.ai/api/v1/models", "http://127.0.0.1:8188/", "not a url", "wss://api.openai.com/v1/models",
    ]) await denied(gate.fetch(u));
    await denied(gate.fetch("https://api.openai.com/v1/models", { method: "DELETE" }));
    expect(real).not.toHaveBeenCalled();
    const err = await gate.fetch("https://example.com/secret?token=abc", { body: "BODY" }).catch((e) => e);
    expect(err.code).toBe("EGRESS_DENIED");
    expect(String(err.message) + JSON.stringify(err)).not.toMatch(/secret|token|BODY|example/);
  });

  it("models は GET だけ。Request も method を見る", async () => {
    const { gate, real } = setup();
    await gate.fetch("https://api.openai.com/v1/models", { headers: { Authorization: "Bearer x" } });
    await gate.fetch(new URL("https://api.openai.com/v1/models"));
    await gate.fetch(new Request("https://api.openai.com/v1/models"));
    expect(real).toHaveBeenCalledTimes(3);
    await denied(gate.fetch(new Request("https://api.openai.com/v1/models", { method: "POST", body: "x" })));
  });

  it("responses の POST は許可1回で1回だけ通り、2回目は拒否", async () => {
    const { gate, real } = setup();
    const url = "https://api.openai.com/v1/responses";
    await denied(gate.fetch(url, { method: "POST" })); // 許可なし
    gate.allowAiSendOnce();
    await gate.fetch(url, { method: "post" });
    expect(real).toHaveBeenCalledTimes(1);
    await denied(gate.fetch(url, { method: "POST" }));
    // GET は許可があっても通さず、許可も消費しない
    gate.allowAiSendOnce();
    await denied(gate.fetch(url));
    await gate.fetch(url, { method: "POST" });
    expect(real).toHaveBeenCalledTimes(2);
    // 許可が2回分なら2回通る
    gate.allowAiSendOnce(); gate.allowAiSendOnce();
    await gate.fetch(url, { method: "POST" });
    await gate.fetch(url, { method: "POST" });
    await denied(gate.fetch(url, { method: "POST" }));
  });

  it("許可は期限で失効する", async () => {
    const { gate, advance, real } = setup();
    gate.allowAiSendOnce();
    advance(EGRESS_PERMIT_TTL_MS);
    await denied(gate.fetch("https://api.openai.com/v1/responses", { method: "POST" }));
    expect(real).not.toHaveBeenCalled();
    gate.allowAiSendOnce();
    advance(EGRESS_PERMIT_TTL_MS - 1);
    await gate.fetch("https://api.openai.com/v1/responses", { method: "POST" });
    expect(real).toHaveBeenCalledTimes(1);
  });

  it("redirect は manual 以外 error に固定し、credentials・Referer を付けない", async () => {
    const { gate, real } = setup();
    await gate.fetch(JWKS_URL);
    await gate.fetch(JWKS_URL, { redirect: "follow", credentials: "include", referrer: "https://x.test/" });
    await gate.fetch(JWKS_URL, { redirect: "manual" });
    const inits = real.mock.calls.map((c) => c[1] as RequestInit);
    expect(inits.map((i) => i.redirect)).toEqual(["error", "error", "manual"]);
    for (const i of inits) expect(i).toMatchObject({ credentials: "omit", referrer: "" });
  });
});

describe("installEgress", () => {
  const original = globalThis.fetch;
  const env = process.env.DC_DESIGNER_DESKTOP;
  afterEach(() => {
    uninstallEgressForTest(original);
    if (env === undefined) delete process.env.DC_DESIGNER_DESKTOP; else process.env.DC_DESIGNER_DESKTOP = env;
  });

  it("開発版では包まない", () => {
    delete process.env.DC_DESIGNER_DESKTOP;
    expect(installEgress()).toBe(false);
    expect(globalThis.fetch).toBe(original);
  });

  it("製品版では globalThis.fetch を1回だけ包み、許可外を拒否する", async () => {
    process.env.DC_DESIGNER_DESKTOP = "1";
    expect(installEgress()).toBe(true);
    expect(installEgress()).toBe(false);
    expect(globalThis.fetch).not.toBe(original);
    await denied(fetch("https://example.com/"));
  });
});
