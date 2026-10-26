import { describe, expect, it } from "vitest";
import { deriveDesktopAccountView, isChatGPTReauthRequired, signInOutcome } from "../src/editor/accountView";
import type { Status } from "../src/editor/api";

const st = (chatgpt: object) => ({ imageProvider: "", imageProviders: [], chatgpt } as unknown as Status);

describe("deriveDesktopAccountView", () => {
  it("状態が無ければ loading", () => expect(deriveDesktopAccountView(null, false)).toEqual({ kind: "loading" }));
  it("未サインイン（前回のメール付き）", () => {
    expect(deriveDesktopAccountView(st({ signedIn: false }), false)).toEqual({ kind: "signedOut" });
    expect(deriveDesktopAccountView(st({ signedIn: false, previousEmail: "a@b.c" }), false)).toEqual({ kind: "signedOut", previousEmail: "a@b.c" });
  });
  it("サインイン済み・プラン未許可", () => {
    expect(deriveDesktopAccountView(st({ signedIn: true, planEnabled: true, email: "a@b.c" }), false)).toEqual({ kind: "signedIn", email: "a@b.c" });
    expect(deriveDesktopAccountView(st({ signedIn: true, planEnabled: false, email: "a@b.c" }), false)).toEqual({ kind: "noPlan", email: "a@b.c" });
  });
  it("再認証が必要なら他の状態より優先する", () => {
    expect(deriveDesktopAccountView(st({ signedIn: true, planEnabled: true, email: "a@b.c" }), true).kind).toBe("reauth");
    expect(deriveDesktopAccountView(st({ signedIn: false }), true).kind).toBe("reauth");
  });
});

describe("isChatGPTReauthRequired", () => {
  const entry = (secretRef: string, state: string) => ({ secretRef, state });
  it("chatgpt/oauth が reauthRequired のときだけ true", () => {
    expect(isChatGPTReauthRequired({ ok: true, data: [entry("openai/apiKey", "configured"), entry("chatgpt/oauth", "reauthRequired")] })).toBe(true);
    expect(isChatGPTReauthRequired({ ok: true, data: [entry("chatgpt/oauth", "configured")] })).toBe(false);
    expect(isChatGPTReauthRequired({ ok: true, data: [entry("openai/apiKey", "reauthRequired")] })).toBe(false);
  });
  it("失敗や読めない形は false", () => {
    expect(isChatGPTReauthRequired({ ok: false, error: "x" })).toBe(false);
    expect(isChatGPTReauthRequired({ ok: true, data: null })).toBe(false);
    expect(isChatGPTReauthRequired(undefined)).toBe(false);
  });
});

describe("signInOutcome", () => {
  it("signed-in / no-plan", () => {
    expect(signInOutcome({ ok: true, data: { result: "signed-in" } }).tone).toBe("success");
    expect(signInOutcome({ ok: true, data: { result: "no-plan" } }).tone).toBe("info");
  });
  it("失敗と不明な結果は成功にしない", () => {
    expect(signInOutcome({ ok: false, error: "キャンセル", code: "CANCELLED" })).toEqual({ tone: "error", text: expect.stringContaining("キャンセル") });
    expect(signInOutcome({ ok: true, data: {} }).tone).toBe("error");
    expect(signInOutcome({ ok: true, data: null }).tone).toBe("error");
  });
});
