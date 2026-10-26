import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MainToWorker, WorkerToMain } from "../desktop/protocol";
import { createMainBackend, getSecret, hasSecret, removeSecret, setSecret, setSecretBackend } from "../server/secrets";

let dir: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "server-secrets-"));
  process.env.DC_DESIGNER_CONFIG_DIR = dir;
  setSecretBackend(null);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
  setSecretBackend(null);
});

describe("開発版の既定実装", () => {
  it("API キーは process.env から読む", async () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(hasSecret("openrouter", "apiKey")).toBe(false);
    expect(await getSecret("openrouter", "apiKey")).toBeUndefined();
    process.env.OPENROUTER_API_KEY = "or-key";
    process.env.OPENAI_API_KEY = "oa-key";
    process.env.GEMINI_API_KEY = "ge-key";
    expect(hasSecret("openrouter", "apiKey")).toBe(true);
    expect(await getSecret("openrouter", "apiKey")).toBe("or-key");
    expect(await getSecret("openai", "apiKey")).toBe("oa-key");
    expect(await getSecret("gemini", "apiKey")).toBe("ge-key");
    await expect(setSecret("openai", "apiKey", "x")).rejects.toThrow();
  });

  it("ChatGPT の資格情報は chatgpt.json を使う", async () => {
    expect(hasSecret("chatgpt", "oauth")).toBe(false);
    expect(await getSecret("chatgpt", "oauth")).toBeUndefined();
    await setSecret("chatgpt", "oauth", '{"a":1}');
    expect(readFileSync(join(dir, "chatgpt.json"), "utf8")).toBe('{"a":1}');
    expect(hasSecret("chatgpt", "oauth")).toBe(true);
    expect(await getSecret("chatgpt", "oauth")).toBe('{"a":1}');
    await removeSecret("chatgpt", "oauth");
    expect(hasSecret("chatgpt", "oauth")).toBe(false);
  });
});

/** main の代わりに応答する parentPort */
function fakePort(respond: (m: WorkerToMain) => MainToWorker | null) {
  let listener: (e: { data: unknown }) => void = () => {};
  const sent: WorkerToMain[] = [];
  return {
    sent,
    deliver: (data: MainToWorker) => listener({ data }),
    port: {
      on: (_: "message", cb: (e: { data: unknown }) => void) => { listener = cb; },
      postMessage: (m: WorkerToMain) => {
        sent.push(m);
        const r = respond(m);
        if (r) queueMicrotask(() => listener({ data: r }));
      },
    },
  };
}

describe("製品版（main への問い合わせ）", () => {
  it("hasSecret は init の状態から答え、get / set / remove で更新する", async () => {
    const f = fakePort((m) => {
      if (m.type === "secret-get") return { type: "secret-result", requestId: m.requestId, ok: true, state: "configured", value: "v" };
      if (m.type === "secret-set") return { type: "secret-result", requestId: m.requestId, ok: true, state: "configured" };
      if (m.type === "secret-remove") return { type: "secret-result", requestId: m.requestId, ok: true, state: "unset" };
      return null;
    });
    setSecretBackend(createMainBackend(f.port, { "openai/apiKey": "configured", "gemini/apiKey": "reauthRequired" }));
    expect(hasSecret("openai", "apiKey")).toBe(true);
    expect(hasSecret("gemini", "apiKey")).toBe(false);
    expect(hasSecret("openrouter", "apiKey")).toBe(false);
    expect(await getSecret("openai", "apiKey")).toBe("v");
    await setSecret("openrouter", "apiKey", "k");
    expect(hasSecret("openrouter", "apiKey")).toBe(true);
    await removeSecret("openai", "apiKey");
    expect(hasSecret("openai", "apiKey")).toBe(false);
    expect(f.sent.map((m) => m.type)).toEqual(["secret-get", "secret-set", "secret-remove"]);
    f.deliver({ type: "secret-changed", secretRef: "gemini/apiKey", state: "configured" });
    expect(hasSecret("gemini", "apiKey")).toBe(true);
  });

  it("main が ChatGPT 操作の外として断ったら、状態を変えずに分かりやすい SecretError にする", async () => {
    const f = fakePort((m) => ({ type: "secret-result", requestId: (m as { requestId: string }).requestId, ok: false, state: "unset", code: "SECRET_DENIED" }));
    setSecretBackend(createMainBackend(f.port, { "chatgpt/oauth": "configured" }));
    await expect(getSecret("chatgpt", "oauth")).rejects.toMatchObject({ state: "failed", message: expect.stringContaining("ChatGPT を使う操作の外") });
    await expect(setSecret("chatgpt", "oauth", "v")).rejects.toMatchObject({ state: "failed" });
    await expect(removeSecret("chatgpt", "oauth")).rejects.toMatchObject({ state: "failed" });
    expect(hasSecret("chatgpt", "oauth")).toBe(true);
  });

  it("reauthRequired は例外、応答が無ければ時間切れ", async () => {
    const f = fakePort((m) => (m.type === "secret-get" ? { type: "secret-result", requestId: m.requestId, ok: false, state: "reauthRequired" } : null));
    setSecretBackend(createMainBackend(f.port, {}, 20));
    await expect(getSecret("openai", "apiKey")).rejects.toMatchObject({ state: "reauthRequired" });
    expect(hasSecret("openai", "apiKey")).toBe(false);
    await expect(setSecret("openai", "apiKey", "k")).rejects.toMatchObject({ state: "failed" });
    vi.useRealTimers();
  });
});
