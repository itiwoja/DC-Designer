import { describe, expect, it } from "vitest";
import { PosterSpecSchema } from "../src/schema";
import { normalizeSequence, removeToSequence } from "../server/deck-sequence";

const spec = (title: string) => PosterSpecSchema.parse({ meta: { title, width: 1000, height: 1414 }, theme: "ocean", layers: [] });
const all = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("normalizeSequence", () => {
  it("5 枚を 3 枚に圧縮する並びを通す", () => {
    expect(normalizeSequence([1, 2, 3], { total: 5, editable: all(5) })).toEqual([1, 2, 3]);
  });

  it("分割: {spec} を 2 の直後に挿入できる（検証済みの spec になる）", () => {
    const r = normalizeSequence([1, 2, { spec: spec("分割A") }, { new: spec("分割B") }, 3], { total: 3, editable: all(3) })!;
    expect(r).toHaveLength(5);
    expect((r[2] as { spec: { meta: { title: string } } }).spec.meta.title).toBe("分割A");
    expect((r[3] as { spec: { meta: { title: string } } }).spec.meta.title).toBe("分割B");
  });

  it("入れ替え", () => {
    expect(normalizeSequence([1, 4, 3, 2], { total: 4, editable: [] })).toEqual([1, 4, 3, 2]);
  });

  it("複製: 同じ番号を 2 回書ける", () => {
    expect(normalizeSequence([1, 2, 3, 3], { total: 3, editable: all(3) })).toEqual([1, 2, 3, 3]);
  });

  it("旧 remove を sequence に変換して渡せる", () => {
    const seq = removeToSequence([4, 5], 5);
    expect(seq).toEqual([1, 2, 3]);
    expect(normalizeSequence(seq, { total: 5, editable: all(5) })).toEqual([1, 2, 3]);
    expect(removeToSequence([], 5)).toBeUndefined();
  });

  it("文字だけの参考スライドを落とした並びはエラー", () => {
    expect(() => normalizeSequence([1, 3], { total: 3, editable: [1, 3] })).toThrow("参考スライド 2");
  });

  it("範囲外・整数でない番号・空配列・不正な要素はエラー", () => {
    const o = { total: 3, editable: all(3) };
    expect(() => normalizeSequence([1, 4], o)).toThrow("1〜3");
    expect(() => normalizeSequence([0, 1], o)).toThrow("1〜3");
    expect(() => normalizeSequence([1.5], o)).toThrow("1〜3");
    expect(() => normalizeSequence([], o)).toThrow("空");
    expect(() => normalizeSequence([1, {}], o)).toThrow("spec");
    expect(() => normalizeSequence([1, { spec: { layers: "x" } }], o)).toThrow();
  });

  it("[1..total] そのままなら（null も）undefined", () => {
    expect(normalizeSequence([1, 2, 3], { total: 3, editable: all(3) })).toBeUndefined();
    expect(normalizeSequence(null, { total: 3, editable: all(3) })).toBeUndefined();
    expect(normalizeSequence(undefined, { total: 3, editable: all(3) })).toBeUndefined();
  });
});
