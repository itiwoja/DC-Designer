import { describe, expect, it } from "vitest";
import { animationGroups, animationSequence, buildTimingXml, insertTiming, renumberAnimations } from "../src/animation";
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
