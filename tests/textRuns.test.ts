import { describe, expect, it } from "vitest";
import { lineSegments, paintRange, rangeColor, shiftRuns, withText } from "../src/textRuns";
import { applyLayerPatch } from "../server/layer-patch";
import type { PosterSpec } from "../src/schema";

describe("部分色", () => {
  it("paintRange は重なりを上書きし、同じ色の隣はつなぐ", () => {
    let r = paintRange(undefined, "abcdefgh", 1, 4, "red");
    expect(r).toEqual([{ start: 1, end: 4, color: "red" }]);
    r = paintRange(r, "abcdefgh", 3, 6, "blue");
    expect(r).toEqual([{ start: 1, end: 3, color: "red" }, { start: 3, end: 6, color: "blue" }]);
    r = paintRange(r, "abcdefgh", 3, 6, "red");
    expect(r).toEqual([{ start: 1, end: 6, color: "red" }]);
    expect(paintRange(r, "abcdefgh", 0, 8, null)).toEqual([]);
  });

  it("rangeColor は範囲の色が揃っているときだけ返す", () => {
    const r = [{ start: 1, end: 3, color: "red" }];
    expect(rangeColor(r, "abcd", 1, 3)).toBe("red");
    expect(rangeColor(r, "abcd", 3, 4)).toBeNull();
    expect(rangeColor(r, "abcd", 0, 2)).toBeUndefined();
  });

  it("shiftRuns: 挿入は直前の文字の色、置き換えは置き換えた先頭の色を引き継ぐ", () => {
    const r = [{ start: 2, end: 4, color: "red" }]; // "ab[cd]ef"
    expect(shiftRuns(r, "abcdef", "XXabcdef")).toEqual([{ start: 4, end: 6, color: "red" }]);
    expect(shiftRuns(r, "abcdef", "abcdXef")).toEqual([{ start: 2, end: 5, color: "red" }]);
    expect(shiftRuns(r, "abcdef", "abXcdef")).toEqual([{ start: 3, end: 5, color: "red" }]);
    expect(shiftRuns(r, "abcdef", "abZZZef")).toEqual([{ start: 2, end: 5, color: "red" }]);
    expect(shiftRuns(r, "abcdef", "abef")).toEqual([]);
    expect(withText({ text: "abcdef", colorRuns: r }, "abef")).toEqual({ text: "abef", colorRuns: undefined });
  });

  it("lineSegments は行と色の切れ目で分ける", () => {
    expect(lineSegments("ab\ncd", [{ start: 1, end: 4, color: "red" }])).toEqual([
      [{ text: "a", color: undefined }, { text: "b", color: "red" }],
      [{ text: "c", color: "red" }, { text: "d", color: undefined }],
    ]);
    expect(lineSegments("a\n\nb", undefined)).toEqual([[{ text: "a", color: undefined }], [], [{ text: "b", color: undefined }]]);
  });

  it("AI が文字だけ直したら部分色の位置を合わせる", () => {
    const spec = {
      version: 1, meta: { title: "t", width: 100, height: 100 }, theme: "ocean",
      layers: [{ id: "t1", type: "text", text: "春の祭り", colorRuns: [{ start: 2, end: 4, color: "$accent" }] }],
    } as unknown as PosterSpec;
    const next = applyLayerPatch(spec, { update: [{ id: "t1", text: "秋の祭り" }] });
    expect((next.layers[0] as any).colorRuns).toEqual([{ start: 2, end: 4, color: "$accent" }]);
    const longer = applyLayerPatch(spec, { update: [{ id: "t1", text: "ああ春の祭り" }] });
    expect((longer.layers[0] as any).colorRuns).toEqual([{ start: 4, end: 6, color: "$accent" }]);
  });
});
