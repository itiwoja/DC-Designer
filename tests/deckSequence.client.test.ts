import { describe, expect, it } from "vitest";
import { nearestKept, planDeckSequence } from "../src/editor/deckSequence";
import type { PosterSpec } from "../src/schema";

const sp = (t: string) => ({ meta: { title: t } }) as unknown as PosterSpec;
const ids = ["a", "b", "c", "d", "e"];

describe("planDeckSequence", () => {
  it("5 枚を 3 枚に圧縮: 書き換えて残り、4・5 を消す", () => {
    const edits = new Map([[1, sp("1'")], [2, sp("2'")], [3, sp("3'")]]);
    const p = planDeckSequence(ids, [1, 2, 3], edits);
    expect(p.slots.map((s) => s.type)).toEqual(["keep", "keep", "keep"]);
    expect(p.rewrites.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(p.removed).toEqual(["d", "e"]);
    // 開いていた 4 枚目が消えるときは、残る中で一番近い 3 枚目へ
    expect(nearestKept(ids, ["a", "b", "c"], "d")).toBe("c");
    expect(nearestKept(ids, ["a", "b", "c"], "e")).toBe("c");
  });

  it("分割: 新規 2 枚が並びに入る", () => {
    const n1 = sp("n1"), n2 = sp("n2");
    const p = planDeckSequence(ids, [1, { spec: n1 }, { spec: n2 }, 3, 4, 5], new Map([[2, sp("2'")]]));
    expect(p.slots.map((s) => s.type)).toEqual(["keep", "new", "new", "keep", "keep", "keep"]);
    expect(p.removed).toEqual(["b"]);
    expect(p.rewrites).toEqual([]);
  });

  it("入れ替え: 並びだけ変わり、消すものも書き換えも無い", () => {
    const p = planDeckSequence(ids, [1, 4, 3, 2, 5], new Map());
    expect(p.slots.map((s) => (s.type === "keep" ? s.id : "?"))).toEqual(["a", "d", "c", "b", "e"]);
    expect(p.removed).toEqual([]);
    expect(p.rewrites).toEqual([]);
  });

  it("複製: 2 回目以降の同じ番号は copy", () => {
    const p = planDeckSequence(ids, [1, 2, 3, 4, 5, 3], new Map());
    expect(p.slots[5]).toEqual({ type: "copy", from: "c", n: 3 });
    expect(p.slots.slice(0, 5).every((s) => s.type === "keep")).toBe(true);
    expect(p.removed).toEqual([]);
  });

  it("sequence がそのままなら変化なし（書き換えだけ）", () => {
    const p = planDeckSequence(ids, [1, 2, 3, 4, 5], new Map([[2, sp("x")]]));
    expect(p.slots.every((s) => s.type === "keep")).toBe(true);
    expect(p.removed).toEqual([]);
    expect(p.rewrites.map((r) => r.id)).toEqual(["b"]);
  });

  it("範囲外の番号は無視し、消えるスライドの書き換えは捨てる", () => {
    const p = planDeckSequence(ids, [1, 9, 0], new Map([[2, sp("x")]]));
    expect(p.slots).toHaveLength(1);
    expect(p.rewrites).toEqual([]);
    expect(p.removed).toEqual(["b", "c", "d", "e"]);
  });
});

describe("nearestKept", () => {
  it("残るものが無ければ null", () => expect(nearestKept(ids, [], "a")).toBeNull());
  it("同じ距離なら後ろ側", () => expect(nearestKept(ids, ["a", "c"], "b")).toBe("c"));
});
