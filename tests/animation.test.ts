import { describe, expect, it } from "vitest";
import { animationGroups, animationSequence, buildTimingXml, insertTiming, normalizeDirection, planScroll, renumberAnimations, scrollLayout } from "../src/animation";
import { PosterSpecSchema, type LayerAnimation, type PosterSpec } from "../src/schema";

const anim = (a: Partial<LayerAnimation>): LayerAnimation => ({ effect: "fade", start: "click", duration: 500, delay: 0, ...a });
const spec = (layers: object[]): PosterSpec => PosterSpecSchema.parse({ meta: {}, layers });
const text = (id: string, animation?: Partial<LayerAnimation>) => ({ id, type: "text", text: id, ...(animation ? { animation: anim(animation) } : {}) });

describe("アニメーションの順番", () => {
  it("order 順、無ければ重ね順。非表示と背景は再生しない", () => {
    const s = spec([
      { id: "bg", type: "background", fill: "#fff", animation: anim({}) },
      text("a", { order: 2 }),
      text("b", { order: 1 }),
      text("c", {}),
      { ...text("d", { order: 3 }), visible: false },
      text("e"),
    ]);
    expect(animationSequence(s).map((x) => x.layer.id)).toEqual(["b", "a", "c"]);
  });

  it("振り直しと前後の入れ替え", () => {
    const s = spec([text("a", { order: 5 }), text("b", { order: 9 }), text("c")]);
    const r = renumberAnimations(s);
    expect(r.layers.map((l) => l.animation?.order)).toEqual([1, 2, undefined]);
    const m = renumberAnimations(r, { ids: ["b"], dir: -1 });
    expect(animationSequence(m).map((x) => x.layer.id)).toEqual(["b", "a"]);
    // 端からは動かない
    expect(animationSequence(renumberAnimations(m, { ids: ["b"], dir: -1 })).map((x) => x.layer.id)).toEqual(["b", "a"]);
  });

  it("複数をまとめて前後に動かす", () => {
    const ids = (s: ReturnType<typeof spec>) => animationSequence(s).map((x) => x.layer.id);
    const s = renumberAnimations(spec(["a", "b", "c", "d", "e"].map((id) => text(id, {}))));
    // 離れていても並びは保ったまま 1 つずつ後ろへ
    expect(ids(renumberAnimations(s, { ids: ["b", "d"], dir: 1 }))).toEqual(["a", "c", "b", "e", "d"]);
    expect(ids(renumberAnimations(s, { ids: ["b", "c"], dir: -1 }))).toEqual(["b", "c", "a", "d", "e"]);
    // どれかが端にあるときは動かさない
    expect(ids(renumberAnimations(s, { ids: ["a", "c"], dir: -1 }))).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("再生のまとまり", () => {
  it("クリックで区切り、同時はまとめ、後は前の終わりから", () => {
    const s = spec([
      text("a", { start: "with", duration: 400 }),
      text("b", { start: "after", duration: 300, delay: 100 }),
      text("c", { start: "click" }),
      text("d", { start: "with", delay: 200, duration: 1000 }),
      text("e", { start: "after" }),
    ]);
    const g = animationGroups(animationSequence(s));
    expect(g.map((x) => x.auto)).toEqual([true, false]);
    expect(g[0].steps.map((st) => [st.offset, st.items.map((i) => i.id)])).toEqual([[0, ["a"]], [400, ["b"]]]);
    // c(0〜500) と d(200〜1200) の遅い方の後に e
    expect(g[1].steps.map((st) => [st.offset, st.items.map((i) => i.id)])).toEqual([[0, ["c", "d"]], [1200, ["e"]]]);
  });
});

describe("PowerPoint の timing", () => {
  const s = spec([
    text("title", { effect: "fly", direction: "left" }),
    { id: "pic", type: "image", animation: anim({ effect: "zoom", start: "after" }) },
    text("note", { effect: "wipe", direction: "bottom", start: "click" }),
  ]);
  const xml = buildTimingXml(animationGroups(animationSequence(s)), new Map([["title", 2], ["pic", 3], ["note", 4]]), new Set(["title", "note"]));

  it("各図形を対象にし、cTn の id は重複しない", () => {
    expect(xml.startsWith("<p:timing>")).toBe(true);
    expect(xml).toContain('presetID="2" presetClass="entr" presetSubtype="8"');
    expect(xml).toContain('nodeType="afterEffect"');
    expect(xml).toContain('filter="wipe(up)"');
    expect(xml).toContain('<p:bldP spid="2" grpId="0" animBg="1"/><p:bldP spid="4" grpId="0" animBg="1"/>');
    expect(xml).not.toContain('bldP spid="3"');
    const ids = [...xml.matchAll(/<p:cTn id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    // タグの開閉が揃っている
    const open = [...xml.matchAll(/<(p:[a-zA-Z]+)[^>]*?(?<!\/)>/g)].map((m) => m[1]);
    const close = [...xml.matchAll(/<\/(p:[a-zA-Z]+)>/g)].map((m) => m[1]);
    expect(open.sort()).toEqual(close.sort());
  });

  it("書き出せた図形が無ければ空、slide.xml には extLst の前に入れる", () => {
    expect(buildTimingXml(animationGroups(animationSequence(s)), new Map())).toBe("");
    const slide = '<p:sld><p:cSld><p:spTree/></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:extLst><p:ext/></p:extLst></p:sld>';
    expect(insertTiming(slide, xml)).toBe(slide.replace("<p:extLst>", xml + "<p:extLst>"));
    const plain = '<p:sld><p:cSld/></p:sld>';
    expect(insertTiming(plain, xml)).toBe(`<p:sld><p:cSld/>${xml}</p:sld>`);
  });
});

describe("斜めのスライドイン", () => {
  const timing = (a: Partial<LayerAnimation>) => buildTimingXml(animationGroups(animationSequence(spec([text("t", { effect: "fly", ...a })]))), new Map([["t", 2]]), new Set(["t"]));

  it("presetSubtype は上 1・右 2・下 4・左 8 の足し算で、x と y の両方を画面外から動かす", () => {
    const sub = (d: LayerAnimation["direction"]) => timing({ direction: d }).match(/presetSubtype="(\d+)"/)![1];
    expect([sub("topright"), sub("bottomright"), sub("bottomleft"), sub("topleft")]).toEqual(["3", "6", "12", "9"]);
    const xml = timing({ direction: "topleft" });
    expect(xml).toContain('<p:strVal val="0-#ppt_w/2"/>');
    expect(xml).toContain('<p:strVal val="0-#ppt_h/2"/>');
    const br = timing({ direction: "bottomright" });
    expect(br).toContain('<p:strVal val="1+#ppt_w/2"/>');
    expect(br).toContain('<p:strVal val="1+#ppt_h/2"/>');
  });

  it("斜めを選べない効果では上下左右にそろう", () => {
    expect(normalizeDirection("wipe", "topleft")).toBe("top");
    expect(normalizeDirection("scroll", "bottomright")).toBe("bottom");
    expect(normalizeDirection("fly", "bottomright")).toBe("bottomright");
    expect(normalizeDirection("fade", "top")).toBeUndefined();
    expect(timing({ effect: "wipe", direction: "bottomleft" })).toContain('filter="wipe(up)"');
  });
});

describe("スクロール", () => {
  // 幅 400 高さ 200 の枠に、縦長（幅/高さ = 0.5）の画像 → 画像は 400x800 で、600 流せる
  const frame = { x: 100, y: 300, w: 400, h: 200 };
  const slide = { width: 1280, height: 720 };
  const a = (p: Partial<LayerAnimation> = {}) => anim({ effect: "scroll", direction: "bottom", ...p });

  it("画像全体の大きさと、動かす量", () => {
    const down = scrollLayout(frame, 0.5, "bottom");
    expect(down).toMatchObject({ vertical: true, travel: 600, img: { x: 0, y: 0, w: 400, h: 800 }, move: { dx: 0, dy: -600 } });
    // 逆向きは下端から始めて戻す。scrollTo で途中まで
    expect(scrollLayout(frame, 0.5, "top").img.y).toBe(-600);
    expect(scrollLayout(frame, 0.5, "top").move.dy).toBe(600);
    expect(scrollLayout(frame, 0.5, "bottom", 0.5).move.dy).toBe(-300);
    // 横長の画像を左→右: 高さを枠に合わせる（800x200）
    expect(scrollLayout(frame, 4, "right")).toMatchObject({ vertical: false, travel: 400, img: { w: 800, h: 200 }, move: { dx: -400, dy: 0 } });
    // はみ出していない向きは流せない
    expect(scrollLayout(frame, 0.5, "right").travel).toBe(0);
  });

  it("PPTX の配置: 画像全体 + 枠の上下の帯（スライドの外は要らない）", () => {
    const p = planScroll(frame, 0.5, a(), slide)!;
    expect(p.picture).toEqual({ x: 100, y: 300, w: 400, h: 800 });
    expect(p.move.x).toBe(0);
    expect(p.move.y).toBeCloseTo(-600 / 720);
    // 上の帯: 流れた後の画像は枠の上にはみ出す（スライドの上端まで）。下の帯: 枠の下端 500 → スライドの下端 720
    expect(p.bands).toEqual([{ x: 100, y: 0, w: 400, h: 300 }, { x: 100, y: 500, w: 400, h: 220 }]);
    // 枠がスライドの下端に接している辺には帯が付かない
    const edge = planScroll({ ...frame, y: 520 }, 0.5, a(), slide)!;
    expect(edge.bands).toEqual([{ x: 100, y: 0, w: 400, h: 520 }]);
    // 下から上へ: 始めは画像の上端が枠より上に出る
    const up = planScroll(frame, 0.5, a({ direction: "top" }), slide)!;
    expect(up.picture.y).toBe(-300);
    expect(up.bands).toEqual([{ x: 100, y: 0, w: 400, h: 300 }, { x: 100, y: 500, w: 400, h: 220 }]);
    // 横
    const h = planScroll(frame, 4, a({ direction: "right" }), slide)!;
    expect(h.bands).toEqual([{ x: 0, y: 300, w: 100, h: 200 }, { x: 500, y: 300, w: 400, h: 200 }]);
    expect(h.move.x).toBeCloseTo(-400 / 1280);
  });

  it("流せないものは null（回転・はみ出しなし）", () => {
    expect(planScroll({ ...frame, rotation: 10 }, 0.5, a(), slide)).toBeNull();
    expect(planScroll(frame, 2, a(), slide)).toBeNull();
  });

  it("animMotion を path で書き、cTn の id は重複しない", () => {
    const s = spec([
      text("t", { effect: "fly", direction: "topright", sound: "pop" }),
      { id: "pic", type: "image", animation: a({ start: "with" }) },
      { id: "pic2", type: "image", animation: a({ start: "click" }) },
    ]);
    const xml = buildTimingXml(animationGroups(animationSequence(s)), new Map([["t", 2], ["pic", 3], ["pic2", 6]]), new Set(["t"]), new Map([["pic", { x: 0, y: -0.5 }], ["pic2", { x: -0.25, y: 0 }]]));
    expect(xml).toContain('presetID="0" presetClass="path" presetSubtype="0"');
    expect(xml).toContain('<p:animMotion origin="layout" path="M 0 0 L 0 -0.5 E" pathEditMode="relative" rAng="0" ptsTypes="AA">');
    expect(xml).toContain('path="M 0 0 L -0.25 0 E"');
    expect(xml).toContain('<p:rCtr x="0" y="-25000"/>');
    expect(xml).toContain('<p:spTgt spid="3"/>');
    const ids = [...xml.matchAll(/<p:cTn id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const open = [...xml.matchAll(/<(p:[a-zA-Z]+)[^>]*?(?<!\/)>/g)].map((m) => m[1]);
    const close = [...xml.matchAll(/<\/(p:[a-zA-Z]+)>/g)].map((m) => m[1]);
    expect(open.sort()).toEqual(close.sort());
    // 動きが決まっていないスクロールは書かない
    expect(buildTimingXml(animationGroups(animationSequence(s)), new Map([["pic", 3]]))).toBe("");
  });
});
