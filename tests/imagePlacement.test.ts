import { describe, expect, it } from "vitest";
import type { Layer } from "../src/schema";
import { placeImage, replaceableByImage } from "../src/editor/specOps";

const W = 1920, H = 1080;
const img = (x: number, y: number, w: number, h: number) => ({ id: "a", type: "image", x, y, w, h, src: "/a.png" }) as unknown as Layer;

describe("placeImage", () => {
  it("box 無しは元の縦横比のまま画面の半分以内で中央に置く", () => {
    const p = placeImage({ w: 4000, h: 2000 }, W, H, 0);
    expect(p.w).toBe(960);
    expect(p.h).toBe(480);
    expect(p).toMatchObject({ x: 480, y: 300 });
  });
  it("小さい画像は拡大しない", () => {
    expect(placeImage({ w: 100, h: 50 }, W, H, 0)).toMatchObject({ w: 100, h: 50 });
  });
  it("全面の box を渡しても画面の半分以内・縦横比維持で box の中央に置く", () => {
    const p = placeImage({ w: 3000, h: 3000 }, W, H, 0, { box: { x: 0, y: 0, w: W, h: H } });
    expect(p.w).toBe(540);
    expect(p.h).toBe(540);
    expect(p.x).toBe(690);
    expect(p.y).toBe(270);
  });
  it("小さな box には box に収める", () => {
    const p = placeImage({ w: 1000, h: 500 }, W, H, 0, { box: { x: 100, y: 100, w: 200, h: 200 } });
    expect(p).toMatchObject({ w: 200, h: 100, x: 100, y: 150 });
  });
  it("box の回転は引き継ぎ、複数枚は 20px ずつずらす", () => {
    const p = placeImage({ w: 100, h: 100 }, W, H, 2, { box: { x: 0, y: 0, w: 100, h: 100, rotation: 10 } });
    expect(p).toMatchObject({ x: 40, y: 40, rotation: 10 });
  });
  it("at を中心に置く", () => {
    expect(placeImage({ w: 100, h: 100 }, W, H, 0, { at: { x: 500, y: 400 } })).toMatchObject({ x: 450, y: 350 });
  });
});

describe("replaceableByImage", () => {
  it("全面（9 割以上）の画像は差し替えない", () => {
    expect(replaceableByImage(img(0, 0, W, H), W, H)).toBe(false);
    expect(replaceableByImage(img(0, 0, W * 0.96, H * 0.96), W, H)).toBe(false);
  });
  it("通常の大きさの画像は差し替える", () => {
    expect(replaceableByImage(img(100, 100, 600, 400), W, H)).toBe(true);
  });
  it("画像でないレイヤー・null は差し替えない", () => {
    expect(replaceableByImage(null, W, H)).toBe(false);
    expect(replaceableByImage({ id: "t", type: "text", x: 0, y: 0, w: 10, h: 10 } as unknown as Layer, W, H)).toBe(false);
  });
});
