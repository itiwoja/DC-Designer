import { describe, expect, it } from "vitest";
import { PosterSpecSchema } from "../src/schema";
import { optString, parseAcross, parseDeckContext, parseImage, parseTurns, strings } from "../server/request-parsers";

const spec = PosterSpecSchema.parse({ meta: { title: "テスト", width: 1000, height: 1414 }, theme: "ocean", layers: [] });

describe("request parsers", () => {
  it("任意の文字列と配列を上限まで取り出す", () => {
    expect(optString("abcdef", 3)).toBe("abc");
    expect(optString("", 3)).toBe("");
    expect(optString(4, 3)).toBeUndefined();
    expect(strings(["a", 2, "b"], 1)).toEqual(["a"]);
  });
  it("デッキ位置を数値に変換して範囲を確認する", () => {
    expect(parseAcross({ number: "2", total: "3" })).toEqual({ number: 2, total: 3, guide: undefined });
    expect(parseAcross({ number: 0, total: 3 })).toBeUndefined();
    expect(parseAcross(undefined)).toBeUndefined();
    expect(parseAcross({ number: 4, total: 3 })).toBeUndefined();
    expect(parseAcross({ number: 1.5, total: 3 })).toBeUndefined();
    expect(parseAcross({ number: 1, total: 3, guide: "x".repeat(1001) })?.guide).toHaveLength(1000);
  });
  it("発言を絞り込み文字数を制限する", () => {
    expect(parseTurns([{ role: "user", text: "x".repeat(1001) }, { role: "system", text: "ignored" }, { role: "assistant", text: " " }])).toEqual([{ role: "user", text: "x".repeat(1000) }]);
  });
  it("デッキのspec検証と文字列一覧の上限を維持する", () => {
    expect(parseDeckContext({ current: "1", total: "1", slides: [{ number: "1", spec, texts: Array(35).fill("x") }] })?.slides[0].texts).toHaveLength(30);
    expect(() => parseDeckContext({ current: 1, total: 1, slides: [{ number: 1, spec: {} }] })).toThrow();
    expect(parseDeckContext(undefined)).toBeUndefined();
    expect(parseDeckContext({ current: "bad", total: 1, slides: [] })).toBeUndefined();
  });
  it.each([undefined, { mediaType: "text/plain", data: "x" }, { mediaType: "image/png", data: "" }])("不正な画像をHTTP 400で拒否する: %j", (value) => {
    expect(() => parseImage(value, "reference")).toThrow(expect.objectContaining({ status: 400, message: "reference は { mediaType, data } の画像で指定してください" }));
  });
  it("対応する画像形式をそのまま返す", () => {
    const image = { mediaType: "image/png", data: "YWJj" };
    expect(parseImage(image, "reference")).toEqual(image);
  });
});
