import { describe, expect, it } from "vitest";
import type { Layer, PosterSpec } from "../src/schema";
import { alignedPosition, aspectOf, diffLayers, insertAfter, moveLayerTo, patchAsset, prepareAsset, reorderLayer, safeFileName, toLayerRef } from "../src/editor/specOps";

const sample: PosterSpec = {
  version: 1, meta: { title: "テストのポスター", width: 1000, height: 1414 }, theme: "ocean",
  layers: [{ id: "bg", type: "background", fill: "$background", x: 0, y: 0, w: 1000, h: 1414 }],
};
const img = (id: string, extra: object = {}) => ({ id, type: "image", x: 0, y: 0, w: 100, h: 100, ...extra }) as Layer;
const withLayers = (...layers: Layer[]): PosterSpec => ({ ...sample, layers: [...sample.layers, ...layers] });

describe("小物", () => {
  it("aspectOf は縦横比で分ける", () => {
    expect(aspectOf(1600, 900)).toBe("landscape");
    expect(aspectOf(900, 1600)).toBe("portrait");
    expect(aspectOf(100, 100)).toBe("square");
  });

  it("safeFileName はファイル名に使えない文字を置き換える", () => {
    expect(safeFileName('a/b:c*?"<>|')).toBe("a_b_c______");
    expect(safeFileName("")).toBe("poster");
  });

  it("insertAfter は afterId の直後、無ければ末尾に入れる", () => {
    const ls = [img("a"), img("b")];
    expect(insertAfter(ls, "a", [img("x")]).map((l) => l.id)).toEqual(["a", "x", "b"]);
    expect(insertAfter(ls, "none", [img("x")]).map((l) => l.id)).toEqual(["a", "b", "x"]);
    expect(ls.map((l) => l.id)).toEqual(["a", "b"]);
  });
});

describe("画像の差し替え", () => {
  it("レイヤー順が変わっても ID で追従し、crop.ratio を測り直す", () => {
    const spec = withLayers(img("p", { src: "/old.png", crop: { scale: 1, x: 0, y: 0, ratio: 2 } }));
    const ref = toLayerRef(spec, ["layers", spec.layers.length - 1]);
    const moved = { ...spec, layers: [spec.layers.at(-1)!, ...spec.layers.slice(0, -1)] };
    const out = patchAsset(moved, ref, "/new.png");
    const l = out.layers.find((x) => x.id === "p") as any;
    expect(l.src).toBe("/new.png");
    expect(l.crop.ratio).toBeUndefined();
    // 元の spec は変更しない
    expect((moved.layers[0] as any).src).toBe("/old.png");
  });

  it("src を undefined にすると外す。無いレイヤーなら元のまま", () => {
    const spec = withLayers(img("p", { src: "/a.png" }));
    expect((patchAsset(spec, { layerId: "p", rest: [] }, undefined).layers.at(-1) as any).src).toBeUndefined();
    expect(patchAsset(spec, { layerId: "missing", rest: [] }, "/x.png")).toBe(spec);
  });

  it("prepareAsset は image レイヤーの枠に aspect を合わせ、大きさで role を決める", () => {
    const { width, height } = sample.meta;
    const spec = withLayers(img("hero", { w: width, h: height / 2 }), img("tiny", { w: 50, h: 50 }));
    const asset = { prompt: "cat", aspect: "portrait" } as any;
    const hero = prepareAsset(spec, { layerId: "hero", rest: [] }, asset);
    expect(hero.asset.aspect).toBe("landscape");
    expect(hero.context.role).toBe("hero");
    expect(prepareAsset(spec, { layerId: "tiny", rest: [] }, asset).context.role).toBe("small");
  });
});

describe("diffLayers", () => {
  it("追加・変更・削除・テーマ変更を数える", () => {
    const before = withLayers(img("a"), img("b"));
    const after: PosterSpec = { ...before, theme: before.theme + "-x", layers: [...before.layers.filter((l) => l.id !== "b").map((l) => (l.id === "a" ? { ...l, x: 5 } : l)), img("c")] };
    expect(diffLayers(before, after)).toEqual({ added: ["c"], changed: ["a"], removed: 1, themeChanged: true, metaChanged: false, notesChanged: false, transitionChanged: false, reordered: false, hasChanges: true });
  });

  it("タイトルだけの変更でも hasChanges", () => {
    const before = withLayers(img("a"));
    const d = diffLayers(before, { ...before, meta: { ...before.meta, title: before.meta.title + "!" } });
    expect(d).toMatchObject({ metaChanged: true, hasChanges: true, added: [], changed: [], removed: 0 });
  });

  it("幅の変更でも hasChanges", () => {
    const before = withLayers(img("a"));
    const d = diffLayers(before, { ...before, meta: { ...before.meta, width: 2000 } });
    expect(d).toMatchObject({ metaChanged: true, hasChanges: true });
  });

  it("themeOverride の色変更でも hasChanges", () => {
    const before = withLayers(img("a"));
    const after: PosterSpec = { ...before, themeOverride: { ...before.themeOverride, colors: { ...before.themeOverride?.colors, ink: "#123456" } } };
    expect(diffLayers(before, after)).toMatchObject({ themeChanged: true, hasChanges: true });
  });

  it("レイヤーの並び順だけの変更でも hasChanges", () => {
    const before = withLayers(img("a"), img("b"));
    const after: PosterSpec = { ...before, layers: [...before.layers.slice(0, -2), img("b"), img("a")] };
    expect(diffLayers(before, after)).toMatchObject({ reordered: true, hasChanges: true, added: [], changed: [], removed: 0 });
  });

  it("台本だけの変更でも hasChanges（無しと空文字は同じ）", () => {
    const before = withLayers(img("a"));
    expect(diffLayers(before, { ...before, notes: "ここで質問を投げる" })).toMatchObject({ notesChanged: true, hasChanges: true, changed: [] });
    expect(diffLayers(before, { ...before, notes: "" })).toMatchObject({ notesChanged: false });
  });

  it("同一の spec は hasChanges が false", () => {
    const before = withLayers(img("a"), img("b"));
    expect(diffLayers(before, JSON.parse(JSON.stringify(before)))).toEqual({ added: [], changed: [], removed: 0, themeChanged: false, metaChanged: false, notesChanged: false, transitionChanged: false, reordered: false, hasChanges: false });
  });
});

describe("レイヤーの並べ替え・揃え", () => {
  const bg = { id: "bg", type: "background", fill: "#fff", x: 0, y: 0, w: 100, h: 100 } as Layer;
  const ids = (ls: Layer[]) => ls.map((l) => l.id);

  it("reorderLayer は背景より後ろに回さず、範囲外は端に収める", () => {
    const ls = [bg, img("a"), img("b"), img("c")];
    expect(ids(reorderLayer(ls, "c", () => 0))).toEqual(["bg", "c", "a", "b"]);
    expect(ids(reorderLayer(ls, "a", () => 99))).toEqual(["bg", "b", "c", "a"]);
    expect(reorderLayer(ls, "a", (_, i) => i)).toBe(ls);
    expect(reorderLayer(ls, "none", () => 0)).toBe(ls);
  });

  it("moveLayerTo は対象の上・下に移す", () => {
    const ls = [img("a"), img("b"), img("c")];
    expect(ids(moveLayerTo(ls, "a", "c", true))).toEqual(["b", "c", "a"]);
    expect(ids(moveLayerTo(ls, "c", "a", false))).toEqual(["c", "a", "b"]);
    expect(moveLayerTo(ls, "a", "none", true)).toBe(ls);
  });

  it("alignedPosition は回転時に見た目の外接矩形で揃える", () => {
    const l = img("a", { x: 10, y: 10, w: 100, h: 50 });
    expect(alignedPosition(l, "right", 1000, 1000)).toEqual({ x: 900 });
    expect(alignedPosition(l, "vcenter", 1000, 1000)).toEqual({ y: 475 });
    // 90° 回転すると見た目は 50×100。左端に揃えると見た目の左端が 0 になる
    const r = img("r", { x: 0, y: 0, w: 100, h: 50, rotation: 90 });
    expect((alignedPosition(r, "left", 1000, 1000) as { x: number }).x).toBeCloseTo(-25);
  });
});
