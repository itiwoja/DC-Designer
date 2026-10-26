import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecretStore, type SecretCrypto } from "../desktop/secrets";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "desktop-secrets-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** safeStorage の代わり。ciphertext は平文を含まない形にする */
function fakeCrypto(over: Partial<SecretCrypto> = {}): SecretCrypto {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
    ...over,
  };
}
const files = () => readdirSync(dir).sort();

describe("createSecretStore", () => {
  it("set で ciphertext だけを <providerId>.<kind>.bin に置き、get で戻る", () => {
    const s = createSecretStore({ dir, crypto: fakeCrypto() });
    expect(s.set("openai", "apiKey", "sk-secret")).toMatchObject({ ok: true, state: "configured", secretRef: "openai/apiKey" });
    expect(files()).toEqual(["openai.apiKey.bin"]);
    expect(readFileSync(join(dir, "openai.apiKey.bin")).includes("sk-secret")).toBe(false);
    expect(s.get("openai", "apiKey")).toMatchObject({ ok: true, state: "configured", value: "sk-secret" });
  });

  it("暗号化できないときは失敗し、平文ファイルを作らない", () => {
    const s = createSecretStore({ dir, crypto: fakeCrypto({ isEncryptionAvailable: () => false }) });
    expect(s.set("openai", "apiKey", "sk-secret")).toMatchObject({ ok: false, code: "ENCRYPTION_UNAVAILABLE" });
    expect(files()).toEqual([]);
    const t = createSecretStore({ dir, crypto: fakeCrypto({ encryptString: () => { throw new Error("x"); } }) });
    expect(t.set("openai", "apiKey", "sk-secret")).toMatchObject({ ok: false });
    expect(files()).toEqual([]);
  });

  it("復号できなければ reauthRequired（status も get も）", () => {
    createSecretStore({ dir, crypto: fakeCrypto() }).set("gemini", "apiKey", "g");
    const broken = createSecretStore({ dir, crypto: fakeCrypto({ decryptString: () => { throw new Error("bad"); } }) });
    expect(broken.get("gemini", "apiKey")).toMatchObject({ ok: false, state: "reauthRequired" });
    expect(broken.status().find((e) => e.secretRef === "gemini/apiKey")?.state).toBe("reauthRequired");
    const off = createSecretStore({ dir, crypto: fakeCrypto({ isEncryptionAvailable: () => false }) });
    expect(off.get("gemini", "apiKey").state).toBe("reauthRequired");
  });

  it("set が失敗しても既存の値は残り、tmp も残らない", () => {
    createSecretStore({ dir, crypto: fakeCrypto() }).set("openai", "apiKey", "old");
    const failing = createSecretStore({ dir, crypto: fakeCrypto({ encryptString: () => { throw new Error("x"); } }) });
    expect(failing.set("openai", "apiKey", "new").ok).toBe(false);
    expect(createSecretStore({ dir, crypto: fakeCrypto() }).get("openai", "apiKey").value).toBe("old");
    expect(files()).toEqual(["openai.apiKey.bin"]);
    // 書き込み先が使えない場合（置き換え先が存在しない dir にできない）も既存を壊さない
    const bad = createSecretStore({ dir: join(dir, "openai.apiKey.bin", "sub"), crypto: fakeCrypto() });
    expect(bad.set("openai", "apiKey", "new")).toMatchObject({ ok: false, code: "WRITE_FAILED" });
    expect(readFileSync(join(dir, "openai.apiKey.bin")).length).toBeGreaterThan(0);
  });

  it("カタログ外・長すぎる値・不正な oauth を拒否する", () => {
    const s = createSecretStore({ dir, crypto: fakeCrypto() });
    expect(s.set("evil", "apiKey", "x").code).toBe("INVALID_ARGUMENT");
    expect(s.set("openai", "oauth", "x").code).toBe("INVALID_ARGUMENT");
    expect(s.set("__proto__", "apiKey", "x").code).toBe("INVALID_ARGUMENT");
    expect(s.set("openai", "apiKey", "a".repeat(4097)).code).toBe("INVALID_ARGUMENT");
    expect(s.set("openai", "apiKey", "").code).toBe("INVALID_ARGUMENT");
    expect(s.set("openai", "apiKey", 5).code).toBe("INVALID_ARGUMENT");
    expect(s.set("chatgpt", "oauth", "not json").code).toBe("INVALID_ARGUMENT");
    expect(s.set("chatgpt", "oauth", JSON.stringify({ a: 1 })).ok).toBe(true);
    expect(s.remove("../x/apiKey").code).toBe("INVALID_ARGUMENT");
    expect(s.remove("openai/apiKey/extra").code).toBe("INVALID_ARGUMENT");
    expect(s.get("evil", "x").code).toBe("INVALID_ARGUMENT");
    expect(files()).toEqual(["chatgpt.oauth.bin"]);
  });

  it("remove は未登録でも unset。status と画面向けの応答に値を含めない", () => {
    const s = createSecretStore({ dir, crypto: fakeCrypto() });
    expect(s.remove("openai/apiKey")).toMatchObject({ ok: true, state: "unset" });
    const setRes = s.set("openrouter", "apiKey", "sk-or-secret");
    expect(setRes.value).toBeUndefined();
    expect(JSON.stringify(setRes)).not.toContain("sk-or-secret");
    expect(JSON.stringify(s.status())).not.toContain("sk-or-secret");
    expect(s.status().map((e) => `${e.secretRef}:${e.state}`)).toEqual([
      "openrouter/apiKey:configured", "openai/apiKey:unset", "gemini/apiKey:unset", "chatgpt/oauth:unset",
    ]);
    expect(s.remove("openrouter/apiKey")).toMatchObject({ ok: true, state: "unset" });
    expect(files()).toEqual([]);
  });

  it("壊れたファイルも reauthRequired", () => {
    writeFileSync(join(dir, "openai.apiKey.bin"), "garbage");
    const s = createSecretStore({ dir, crypto: fakeCrypto({ decryptString: () => { throw new Error("bad"); } }) });
    expect(s.status().find((e) => e.providerId === "openai")?.state).toBe("reauthRequired");
  });
});
