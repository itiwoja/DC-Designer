import { describe, expect, it } from "vitest";
import type { PosterSpec } from "../src/schema";
import { applyLayerPatch, isEmptyPatch, parsePatch } from "../server/layer-patch";

const spec: PosterSpec = {
  version: 1,
  meta: { title: "t", width: 1000, height: 1414 },
  theme: "ocean",
  layers: [
    { id: "bg", name: "背景", type: "background", x: 0, y: 0, w: 1000, h: 1414, fill: "#fff" },
    { id: "title", name: "見出し", type: "text", x: 10, y: 20, w: 500, h: 80, text: "こんにちは", font: "display", size: 60, weight: 700, align: "left", fill: "#000", shadow: { color: "#000", dx: 1, dy: 1, blur: 2 } },
    { id: "box", name: "箱", type: "shape", shape: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#f00" },
  ],
} as PosterSpec;

const apply = (changes: unknown) => applyLayerPatch(spec, parsePatch(changes));

describe("applyLayerPatch", () => {
  it("update は書いたフィールドだけ変え、null はフィールドを消す", () => {
    const out = apply({ update: [{ id: "title", y: 24, shadow: null }] });
    const t = out.layers[1] as any;
    expect(t.y).toBe(24);
    expect(t.text).toBe("こんにちは");
    expect(t.shadow).toBeUndefined();
    expect(out.layers[0]).toEqual(spec.layers[0]);
  });

  it("add は最前面、order があればその順に並べる", () => {
    const layer = { id: "dot", name: "点", type: "shape", shape: "ellipse", x: 1, y: 1, w: 5, h: 5, fill: "#00f" };
    expect(apply({ add: [layer] }).layers.map((l) => l.id)).toEqual(["bg", "title", "box", "dot"]);
    expect(apply({ add: [layer], order: ["bg", "dot", "title", "box"] }).layers.map((l) => l.id)).toEqual(["bg", "dot", "title", "box"]);
  });

  it("remove で消せる", () => {
    expect(apply({ remove: ["box"] }).layers.map((l) => l.id)).toEqual(["bg", "title"]);
  });

  it("type が変わる update はレイヤーを丸ごと置き換える", () => {
    const out = apply({ update: [{ id: "box", name: "丸", type: "shape", shape: "ellipse", x: 0, y: 0, w: 10, h: 10 }] });
    expect((out.layers[2] as any).shape).toBe("ellipse");
  });

  it("キャンバスの大きさは変えさせない", () => {
    expect(apply({ meta: { width: 500, imageStyle: "flat" } }).meta).toMatchObject({ width: 1000, height: 1414, imageStyle: "flat" });
  });

  it("おかしな差分は AI に直させるためのエラーになる", () => {
    expect(() => apply({ update: [{ id: "nope", x: 1 }] })).toThrow(/nope/);
    expect(() => apply({ add: [{ id: "box", type: "shape", shape: "rect", x: 0, y: 0, w: 1, h: 1 }] })).toThrow(/既にあります/);
    expect(() => apply({ order: ["bg", "title"] })).toThrow(/抜け: box/);
    expect(() => apply({ update: [{ id: "title", size: "big" }] })).toThrow();
  });

  it("空の差分を判定できる", () => {
    expect(isEmptyPatch(parsePatch({}))).toBe(true);
    expect(isEmptyPatch(parsePatch({ remove: ["box"] }))).toBe(false);
  });
});
