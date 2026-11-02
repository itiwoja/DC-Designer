import { describe, expect, it } from "vitest";
import { slidePalette } from "../src/editor/slidePalette";
import type { PosterSpec } from "../src/schema";

const spec = (layers: any[], extra: Partial<PosterSpec> = {}): PosterSpec =>
  ({ version: 1, meta: { title: "t", width: 100, height: 100 }, theme: "ocean", layers, ...extra }) as PosterSpec;
const base = { x: 0, y: 0, w: 10, h: 10 };

describe("slidePalette", () => {
  it("背景・図形・テキストの色を拾う", () => {
    const s = spec([
      { id: "b", type: "background", fill: "#111111", ...base },
      { id: "s", type: "shape", shape: "rect", fill: "$primary", stroke: "#ff0000", ...base },
      { id: "t", type: "text", text: "a", fill: "#ffffff", outlines: [{ color: "#000000", width: 2 }], ...base },
    ]);
    expect(slidePalette(s).sort()).toEqual(["#000000", "#111111", "#ff0000", "#ffffff", "$primary"].sort());
  });
  it("グラデーションの stops を拾う", () => {
    const s = spec([
      { id: "b", type: "background", fill: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#aaa" }, { offset: 1, color: "#bbb" }] }, ...base },
      { id: "s", type: "shape", shape: "ellipse", fill: { type: "radial", cx: 0.5, cy: 0.5, r: 0.7, stops: [{ offset: 0, color: "#ccc" }, { offset: 1, color: "#ddd" }] }, ...base },
    ]);
    expect(slidePalette(s)).toEqual(["#aaa", "#bbb", "#ccc", "#ddd"]);
  });
  it("group の入れ子と colorRuns を拾う", () => {
    const s = spec([
      { id: "g", type: "group", ...base, children: [
        { id: "g2", type: "group", ...base, children: [
          { id: "t", type: "text", text: "abc", fill: "#111", colorRuns: [{ start: 0, end: 1, color: "#e11" }], ...base },
        ] },
      ] },
    ]);
    expect(slidePalette(s)).toEqual(["#111", "#e11"]);
  });
  it("影の色は含めない", () => {
    const s = spec([{ id: "s", type: "shape", shape: "rect", fill: "#123456", shadow: { color: "#999999" }, ...base }]);
    expect(slidePalette(s)).toEqual(["#123456"]);
  });
  it("多い順・大文字小文字を同じ色として数える・重複なし", () => {
    const s = spec([
      { id: "1", type: "shape", shape: "rect", fill: "#AAA", ...base },
      { id: "2", type: "shape", shape: "rect", fill: "#bbb", ...base },
      { id: "3", type: "shape", shape: "rect", fill: "#aaa", ...base },
      { id: "4", type: "shape", shape: "rect", fill: "#bbb", ...base },
      { id: "5", type: "shape", shape: "rect", fill: "#ccc", ...base },
      { id: "6", type: "shape", shape: "rect", fill: "#bbb", ...base },
    ]);
    expect(slidePalette(s)).toEqual(["#bbb", "#AAA", "#ccc"]);
  });
  it("背景は少なくとも 1 回は入り、同数の図形より前に来る", () => {
    const s = spec([
      { id: "s", type: "shape", shape: "rect", fill: "#222", ...base },
      { id: "b", type: "background", fill: "#111", ...base },
    ]);
    expect(slidePalette(s)).toEqual(["#111", "#222"]);
  });
  it("themeOverride.colors は「$トークン=色」の形で先頭に置く", () => {
    const s = spec([{ id: "s", type: "shape", shape: "rect", fill: "#AAA", ...base }], { themeOverride: { colors: { primary: "#aaa", accent: "#ff00ff" } } });
    expect(slidePalette(s)).toEqual(["$primary=#aaa", "$accent=#ff00ff", "#AAA"]);
  });
  it("上限で切る", () => {
    const layers = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, type: "shape", shape: "rect", fill: `#${String(i).padStart(6, "0")}`, ...base }));
    expect(slidePalette(spec(layers))).toHaveLength(12);
    expect(slidePalette(spec(layers), 3)).toHaveLength(3);
  });
});
