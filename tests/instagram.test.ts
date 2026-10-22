import { describe, expect, it } from "vitest";
import { blankInstagramSpec, IG_RATIOS, ratioOf, resizeCanvas } from "../src/instagram";
import { PosterSpecSchema, type Layer } from "../src/schema";

const spec = (layers: unknown[], width = 1080, height = 1350) => PosterSpecSchema.parse({ meta: { title: "t", width, height }, layers });

describe("ratioOf", () => {
  it("各比率の実寸を見分ける", () => {
    for (const [k, r] of Object.entries(IG_RATIOS)) expect(ratioOf(r.w, r.h)).toBe(k);
  });
  it("拡大縮小しても比率で判定し、どれにも当たらなければ undefined", () => {
    expect(ratioOf(540, 675)).toBe("4:5");
    expect(ratioOf(1000, 1414)).toBeUndefined();
    expect(ratioOf(1333, 750)).toBeUndefined();
  });
});

describe("blankInstagramSpec", () => {
  it("比率の実寸のキャンバスと全面の背景", () => {
    const s = blankInstagramSpec("9:16");
    expect(s.meta).toMatchObject({ width: 1080, height: 1920 });
    expect(s.layers[0]).toMatchObject({ type: "background", w: 1080, h: 1920 });
  });
});

describe("resizeCanvas", () => {
  it("同じ大きさならそのまま返す", () => {
    const s = spec([]);
    expect(resizeCanvas(s, 1080, 1350)).toBe(s);
  });

  it("背景と全面の画像はキャンバスいっぱいに伸ばす", () => {
    const s = spec([
      { id: "bg", type: "background", fill: "#fff", x: 0, y: 0, w: 1080, h: 1350 },
      { id: "photo", type: "image", fit: "cover", x: 0, y: 0, w: 1080, h: 1350 },
    ]);
    const r = resizeCanvas(s, 1080, 1080);
    expect(r.meta).toMatchObject({ width: 1080, height: 1080 });
    for (const l of r.layers) expect(l).toMatchObject({ x: 0, y: 0, w: 1080, h: 1080 });
  });

  it("縦が縮むと、中心を比で移し、大きさと文字も同じ比で縮める", () => {
    const s = spec([{ id: "t", type: "text", text: "見出し", size: 100, x: 140, y: 600, w: 800, h: 150, outlines: [{ color: "#fff", width: 10 }] }]);
    const t = resizeCanvas(s, 1080, 1080).layers[0] as Extract<Layer, { type: "text" }>;
    // 中心 (540, 675) → (540, 540)。k = 0.8 で 640×120
    expect(t).toMatchObject({ w: 640, h: 120, x: 220, y: 480, size: 80 });
    expect(t.outlines?.[0].width).toBe(8);
  });

  it("縦が伸びるときは大きさを変えず、位置だけ移す", () => {
    const s = spec([{ id: "r", type: "shape", shape: "rect", x: 440, y: 440, w: 200, h: 200, radius: 20 }], 1080, 1080);
    const r = resizeCanvas(s, 1080, 1920).layers[0];
    expect(r).toMatchObject({ w: 200, h: 200, x: 440, y: 860, radius: 20 });
  });

  it("グループの子は座標ごと縮める", () => {
    const s = spec([{ id: "g", type: "group", x: 0, y: 100, w: 500, h: 500, children: [{ id: "c", type: "shape", shape: "rect", x: 100, y: 50, w: 200, h: 100 }] }]);
    const g = resizeCanvas(s, 1080, 1080).layers[0] as Extract<Layer, { type: "group" }>;
    expect(g.children[0]).toMatchObject({ x: 80, y: 40, w: 160, h: 80 });
  });
});
