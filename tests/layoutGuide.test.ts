import { describe, expect, it } from "vitest";
import { boundsOf, grayOut, guideScale, planLayoutGuide } from "../src/editor/layoutGuide";
import { PosterSpecSchema, type Layer, type PosterSpec } from "../src/schema";

const mk = (layers: unknown[]): PosterSpec => PosterSpecSchema.parse({ meta: { width: 1000, height: 1000 }, layers });
const img = (extra: object = {}) => ({ id: "hero", type: "image", x: 100, y: 100, w: 600, h: 600, asset: { prompt: "a cat" }, ...extra });
const text = (extra: object = {}) => ({ id: "t", type: "text", text: "Hello", x: 150, y: 150, w: 300, h: 80, fill: "#ff0000", outlines: [{ color: "#000", width: 2 }], ...extra });

describe("planLayoutGuide", () => {
  it("対象より前面で重なるレイヤーだけを灰色にして残し、対象の矩形を返す", () => {
    const spec = mk([
      { id: "bg", type: "background", fill: "#123456" },
      { id: "behind", type: "shape", shape: "rect", x: 100, y: 100, w: 50, h: 50, fill: "#fff" },
      img(),
      text(),
      { id: "far", type: "text", text: "遠い", x: 800, y: 800, w: 100, h: 50 },
    ]);
    const plan = planLayoutGuide(spec, "hero")!;
    expect(plan.rect).toEqual({ x: 100, y: 100, w: 600, h: 600 });
    expect(plan.spec.layers.map((l) => l.id)).toEqual(["guide-bg", "t"]);
    const bg = plan.spec.layers[0] as any;
    expect(bg).toMatchObject({ type: "background", fill: "#ffffff", w: 1000, h: 1000 });
    const t = plan.spec.layers[1] as any;
    expect(t.fill).toBe("#9a9a9a");
    expect(t.outlines).toBeUndefined();
  });

  it("前面に重なるものが無ければ undefined", () => {
    expect(planLayoutGuide(mk([img(), { id: "far", type: "text", text: "x", x: 800, y: 800, w: 100, h: 50 }]), "hero")).toBeUndefined();
    expect(planLayoutGuide(mk([text(), img()]), "hero")).toBeUndefined(); // 文字は背面
  });

  it("透過の素材・小さい画像・asset の無いレイヤー・存在しない id は undefined", () => {
    expect(planLayoutGuide(mk([img({ asset: { prompt: "x", transparent: true } }), text()]), "hero")).toBeUndefined();
    expect(planLayoutGuide(mk([img({ w: 200, h: 200 }), text({ x: 120, y: 120 })]), "hero")).toBeUndefined();
    expect(planLayoutGuide(mk([{ id: "p", type: "image", x: 0, y: 0, w: 600, h: 600, src: "/a.png" }, text()]), "p")).toBeUndefined();
    expect(planLayoutGuide(mk([img(), text()]), "nope")).toBeUndefined();
  });

  it("props.asset を持つ component も対象になる", () => {
    const spec = mk([{ id: "c", type: "component", component: "phone", x: 0, y: 0, w: 600, h: 600, props: { asset: { prompt: "ui" } } }, text({ x: 10, y: 10 })]);
    expect(planLayoutGuide(spec, "c")?.spec.layers).toHaveLength(2);
  });

  it("非表示・ほぼ透明の前面レイヤーは数えない", () => {
    expect(planLayoutGuide(mk([img(), text({ visible: false }), text({ id: "t2", opacity: 0.05 })]), "hero")).toBeUndefined();
  });

  it("紙面からはみ出す対象は紙面の内側に切り詰める", () => {
    const plan = planLayoutGuide(mk([img({ x: -100, y: 500, w: 700, h: 700 }), text({ x: 0, y: 600 })]), "hero")!;
    expect(plan.rect).toEqual({ x: 0, y: 500, w: 600, h: 500 });
  });

  it("元の spec を書き換えない", () => {
    const spec = mk([img(), text()]);
    const before = JSON.stringify(spec);
    planLayoutGuide(spec, "hero");
    expect(JSON.stringify(spec)).toBe(before);
  });
});

describe("grayOut", () => {
  it("画像・コンポーネントは灰色の四角、図形は灰色の塗り、グループは中身も灰色にする", () => {
    const g = (l: unknown) => grayOut(l as Layer) as any;
    expect(g({ id: "i", type: "image", x: 1, y: 2, w: 3, h: 4, src: "/a.png", shadow: { color: "#000", dx: 0, dy: 0, blur: 1 } })).toMatchObject({ type: "shape", shape: "rect", fill: "#9a9a9a", x: 1, y: 2, w: 3, h: 4 });
    expect(g({ id: "c", type: "component", component: "phone", x: 0, y: 0, w: 5, h: 5, props: {} })).toMatchObject({ type: "shape", fill: "#9a9a9a" });
    expect(g({ id: "s", type: "shape", shape: "ellipse", x: 0, y: 0, w: 5, h: 5, fill: { type: "linear" }, stroke: "#f00", animation: { type: "fade" } })).toMatchObject({ fill: "#9a9a9a", stroke: "#9a9a9a", animation: undefined });
    expect(g({ id: "gr", type: "group", x: 0, y: 0, w: 5, h: 5, children: [{ id: "x", type: "text", text: "a", x: 0, y: 0, w: 1, h: 1, fill: "#0f0" }] }).children[0].fill).toBe("#9a9a9a");
  });
});

describe("boundsOf / guideScale", () => {
  it("回転した矩形の外接矩形を返す", () => {
    const b = boundsOf({ x: 0, y: 0, w: 100, h: 50, rotation: 90 });
    expect(b.w).toBeCloseTo(50);
    expect(b.h).toBeCloseTo(100);
    expect(b.x).toBeCloseTo(25);
    expect(b.y).toBeCloseTo(-25);
  });
  it("長辺が 1024px に収まる倍率（拡大はしない）", () => {
    expect(guideScale({ x: 0, y: 0, w: 2048, h: 1000 })).toBe(0.5);
    expect(guideScale({ x: 0, y: 0, w: 500, h: 500 })).toBe(1);
  });
});
