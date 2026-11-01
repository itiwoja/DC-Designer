import { describe, expect, it } from "vitest";
import { geminiHttpError } from "../server/imagegen";
import { failureReason } from "../src/editor/imageErrors";

describe("Gemini の失敗の文言", () => {
  it("無効なキー・権限・上限・Google 側の失敗を、直し方の分かる code に分ける", () => {
    expect(geminiHttpError(400, { message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] })).toMatchObject({ code: "gemini_key_invalid", status: 400 });
    expect(geminiHttpError(400, { message: "API key not valid." })).toMatchObject({ code: "gemini_key_invalid" });
    expect(geminiHttpError(403, { message: "permission denied" })).toMatchObject({ code: "gemini_forbidden", status: 403 });
    expect(geminiHttpError(429, { message: "quota" })).toMatchObject({ code: "gemini_quota", status: 429 });
    expect(geminiHttpError(503, undefined)).toMatchObject({ code: "gemini_server", status: 502 });
    expect(geminiHttpError(400, { message: "bad" })).toMatchObject({ code: "gemini_rejected" });
  });
  it("利用者向けの文言には Google の応答本文を入れない（詳細は message だけ）", () => {
    const e = geminiHttpError(429, { message: "Quota exceeded for project 12345" });
    expect(e.userMessage).not.toContain("12345");
    expect(e.message).toContain("12345");
  });
});

describe("failureReason", () => {
  it("サーバーの文言の末尾の句点を外し、内部エラー・中止・空は理由にしない", () => {
    expect(failureReason(new Error("Gemini の利用上限に達しました。"))).toBe("Gemini の利用上限に達しました");
    expect(failureReason(new Error("内部エラーが発生しました"))).toBeUndefined();
    expect(failureReason(new DOMException("aborted", "AbortError"))).toBeUndefined();
    expect(failureReason(new Error(""))).toBeUndefined();
    expect(failureReason(new Error("あ".repeat(300)))).toBe("あ".repeat(200) + "…");
  });
});
