import { describe, expect, it } from "vitest";
import { nextSlideSelection } from "../src/editor/slideSelection";

const order = ["a", "b", "c", "d", "e"];
const none = { ctrl: false, shift: false };
const ctrl = { ctrl: true, shift: false };
const shift = { ctrl: false, shift: true };
const both = { ctrl: true, shift: true };

describe("nextSlideSelection", () => {
  it("ふつうのクリックは開いて、選択を空に戻す", () => {
    expect(nextSlideSelection(order, ["a", "c"], "a", "a", "d", none)).toEqual({ selected: [], anchor: "d", open: "d" });
  });
  it("Ctrl: 空から始めると、開いているスライドとクリックしたものが選ばれる（開かない）", () => {
    const r = nextSlideSelection(order, [], "b", null, "d", ctrl);
    expect(r).toEqual({ selected: ["b", "d"], anchor: "d" });
    expect(r.open).toBeUndefined();
  });
  it("Ctrl: 追加すると一覧の順に並ぶ", () => {
    expect(nextSlideSelection(order, ["c", "e"], "c", "e", "a", ctrl).selected).toEqual(["a", "c", "e"]);
  });
  it("Ctrl: 選択済みを外す。1 件になったら空", () => {
    expect(nextSlideSelection(order, ["a", "c", "e"], "a", "c", "c", ctrl).selected).toEqual(["a", "e"]);
    expect(nextSlideSelection(order, ["a", "c"], "a", "c", "c", ctrl).selected).toEqual([]);
  });
  it("Ctrl: 開いているスライド自身を空から押すと空のまま", () => {
    expect(nextSlideSelection(order, [], "b", null, "b", ctrl).selected).toEqual([]);
  });
  it("Shift: 起点から後ろへの範囲", () => {
    expect(nextSlideSelection(order, [], "b", "b", "d", shift)).toEqual({ selected: ["b", "c", "d"], anchor: "b" });
  });
  it("Shift: 起点から前への範囲", () => {
    expect(nextSlideSelection(order, [], "d", "d", "b", shift).selected).toEqual(["b", "c", "d"]);
  });
  it("Shift: 起点が無ければ開いているスライドから", () => {
    expect(nextSlideSelection(order, [], "c", null, "e", shift)).toEqual({ selected: ["c", "d", "e"], anchor: "c" });
  });
  it("Shift: 範囲は選び直しで置き換わる", () => {
    expect(nextSlideSelection(order, ["a", "b", "c"], "a", "a", "e", shift).selected).toEqual(["a", "b", "c", "d", "e"]);
    expect(nextSlideSelection(order, ["a", "b", "c", "d"], "a", "a", "b", shift).selected).toEqual(["a", "b"]);
  });
  it("Shift: 起点と同じものなら 1 件で空", () => {
    expect(nextSlideSelection(order, [], "c", "c", "c", shift).selected).toEqual([]);
  });
  it("Ctrl+Shift: 既存の選択に範囲を足す", () => {
    expect(nextSlideSelection(order, ["a", "b"], "a", "d", "e", both).selected).toEqual(["a", "b", "d", "e"]);
  });
  it("Ctrl+Shift: 選択が空なら開いているスライドも含める", () => {
    expect(nextSlideSelection(order, [], "a", "c", "d", both).selected).toEqual(["a", "c", "d"]);
  });
  it("一覧に無い id は無視する", () => {
    expect(nextSlideSelection(order, ["a", "b"], "a", "a", "zz", ctrl)).toEqual({ selected: ["a", "b"], anchor: "a" });
  });
});
