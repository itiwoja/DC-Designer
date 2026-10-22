import { describe, expect, it } from "vitest";
import type { Layer } from "../src/schema";
import { unionBox, type Handle } from "../src/editor/canvas";
import { resizeSelection } from "../src/editor/specOps";

const image = (id: string, x: number, y: number, w: number, h: number): Layer => ({ id, type: "image", x, y, w, h, fit: "contain", src: "/image.png" });
const layers = [image("a", 10, 20, 40, 20), image("b", 70, 60, 40, 60)];

describe("範囲選択の拡大縮小", () => {
  it.each<Handle>([[-1, -1], [1, -1], [1, 1], [-1, 1]])("角 %j の反対側を固定して配置と縦横比を維持する", (hx, hy) => {
    const before = unionBox(layers);
    const out = resizeSelection(layers, [hx, hy], { x: hx * 100, y: hy * 100 });
    const after = unionBox(out);
    expect(after.w).toBeCloseTo(200);
    expect(after.h).toBeCloseTo(200);
    expect(after.x + (1 - hx) * after.w / 2).toBeCloseTo(before.x + (1 - hx) * before.w / 2);
    expect(after.y + (1 - hy) * after.h / 2).toBeCloseTo(before.y + (1 - hy) * before.h / 2);
    expect(out[1].x - out[0].x).toBeCloseTo(120);
    expect(out[0].w / out[0].h).toBe(2);
    expect(layers[0].w).toBe(40);
  });

  it("回転したレイヤーも外接矩形を等倍にする", () => {
    const start = [{ ...layers[0], rotation: 35 }, layers[1]];
    const b = unionBox(start);
    const out = resizeSelection(start, [1, 1], { x: b.w / 2, y: b.h / 2 });
    expect(unionBox(out).w).toBeCloseTo(b.w * 1.5);
    expect(unionBox(out).x).toBeCloseTo(b.x);
    expect(out[0].rotation).toBe(35);
  });

  it("文字・線・グループ内の部品も縮小し、ロックと背景は除外する", () => {
    const text: Layer = { id: "t", type: "text", x: 10, y: 20, w: 100, h: 100, text: "文字", size: 20, font: "body", weight: 700, lineHeight: 1.25, align: "left", fill: "black", outlines: [{ color: "white", width: 2 }] };
    const group: Layer = { id: "g", type: "group", x: 10, y: 20, w: 100, h: 100, children: [text, { id: "s", type: "shape", shape: "rect", x: 0, y: 0, w: 40, h: 40, strokeWidth: 4, radius: 8 }] };
    const out = resizeSelection([group, { ...layers[1], locked: true }, { ...layers[0], type: "background", fill: "white" }], [1, 1], { x: -50, y: -50 });
    expect(out).toHaveLength(1);
    const g = out[0];
    if (g.type !== "group") throw new Error("group expected");
    expect(g.children[0]).toMatchObject({ x: 5, y: 10, size: 10, outlines: [{ width: 1 }] });
    expect(g.children[1]).toMatchObject({ w: 20, h: 20, strokeWidth: 2, radius: 4 });
  });

  it("反対側を越えても反転せず、空選択も安全に扱う", () => {
    expect(resizeSelection([], [1, 1], { x: 1, y: 1 })).toEqual([]);
    const b = unionBox(resizeSelection(layers, [1, 1], { x: -1000, y: -1000 }));
    expect(b.w).toBeCloseTo(8);
    expect(b.h).toBeCloseTo(8);
  });
});
