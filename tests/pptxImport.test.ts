import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { createCanvas } from "@napi-rs/canvas";
import JSZip from "jszip";
import { importPptx } from "../src/import/pptx";
import { animationGroups, animationSequence, buildTimingXml } from "../src/animation";
import { PosterSpecSchema, type LayerAnimation } from "../src/schema";

beforeAll(() => {
  // ブラウザの DOMParser と同じ挙動になるよう xmldom を補う
  const proto = Object.getPrototypeOf(new DOMParser().parseFromString("<a/>", "application/xml").documentElement);
  const ga = proto.getAttribute;
  proto.getAttribute = function (n: string) { return this.hasAttribute(n) ? ga.call(this, n) : null; };
  Object.defineProperty(proto, "children", { get() { return Array.from(this.childNodes).filter((n: any) => n.nodeType === 1); } });
  vi.stubGlobal("DOMParser", DOMParser);
  vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
});
afterEach(() => vi.clearAllMocks());

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
// 幅 1000px × 高さ 500px の図形（1px = 9144 EMU）
const shape = (prst: string, av = "") =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="4572000"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst>${av}</a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="F18D00"/></a:solidFill></p:spPr></p:sp>`;

async function pptxWith(body: string, after = "") {
  const zip = new JSZip();
  zip.file("ppt/presentation.xml", `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="4572000"/></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree></p:cSld>${after}</p:sld>`);
  return importPptx(await zip.generateAsync({ type: "blob" }), "test.pptx", { onImage: async () => null });
}

describe("PPTX の中が抜けた図形", () => {
  it("frame は外枠と穴の 2 つのサブパスを evenodd で持つ", async () => {
    const result = await pptxWith(shape("frame", '<a:gd name="adj1" fmla="val 10000"/>'));
    const layer = result.slides[0].layers.find((l) => l.type === "shape")!;
    expect(layer).toMatchObject({ shape: "path", fillRule: "evenodd", fill: "#f18d00" });
    const d = (layer as { d: string }).d;
    expect(d.match(/M/g)).toHaveLength(2);
    // 太さ = 10% × min(1000, 500) = 50px → 横 0.05、縦 0.1
    expect(d).toContain("M0.05 0.1 L0.95 0.1 L0.95 0.9 L0.05 0.9 Z");
    expect(result.warnings.join()).not.toContain("frame");
  });

  it("donut は adj 省略で既定値（25%）の円弧パスになる", async () => {
    const result = await pptxWith(shape("donut"));
    const layer = result.slides[0].layers.find((l) => l.type === "shape")!;
    expect(layer).toMatchObject({ shape: "path", fillRule: "evenodd" });
    const d = (layer as { d: string }).d;
    expect(d).toContain("A");
    expect(d.match(/M/g)).toHaveLength(2);
    // 太さ 125px → 横 0.125、縦 0.25。穴の半径は 0.375 / 0.25
    expect(d).toContain("M0.125 0.5 A0.375 0.25 0 1 0 0.875 0.5");
    expect(result.warnings.join()).not.toContain("donut");
  });

  it("未対応のプリセットは従来どおり四角形＋警告", async () => {
    const result = await pptxWith(shape("cloud"));
    expect(result.slides[0].layers.find((l) => l.type === "shape")).toMatchObject({ shape: "rect" });
    expect(result.warnings.join()).toContain("cloud");
  });
});

describe("PPTX のアニメーション", () => {
  const box = (id: number, name: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="F18D00"/></a:solidFill></p:spPr></p:sp>`;
  const a = (x: Partial<LayerAnimation>): LayerAnimation => ({ effect: "fade", start: "click", duration: 500, delay: 0, ...x });

  it("buildTimingXml で書いた効果・向き・開始・長さ・遅延・順番が復元される", async () => {
    const spec = PosterSpecSchema.parse({
      meta: {},
      layers: [
        { id: "a", type: "shape", shape: "rect", animation: a({ effect: "fly", direction: "left", duration: 800 }) },
        { id: "b", type: "shape", shape: "rect", animation: a({ effect: "zoom", start: "with", delay: 200, duration: 300 }) },
        { id: "c", type: "shape", shape: "rect", animation: a({ effect: "wipe", direction: "top", start: "after", duration: 1200 }) },
        { id: "d", type: "shape", shape: "rect", animation: a({ effect: "appear" }) },
        { id: "e", type: "shape", shape: "rect", animation: a({ effect: "float", start: "click", delay: 100 }), },
        { id: "f", type: "shape", shape: "rect", animation: a({ effect: "fade", order: 1 }) },
      ],
    });
    const spids = new Map(spec.layers.map((l, i) => [l.id, i + 2]));
    const timing = buildTimingXml(animationGroups(animationSequence(spec)), spids);
    const result = await pptxWith(spec.layers.map((l) => box(spids.get(l.id)!, l.id)).join(""), timing);
    const byName = new Map(result.slides[0].layers.map((l) => [l.name, l.animation]));
    // 再生順は f(1) → a → b → c → d → e
    expect(byName.get("f")).toEqual({ effect: "fade", start: "click", duration: 500, delay: 0, order: 1 });
    expect(byName.get("a")).toEqual({ effect: "fly", direction: "left", start: "click", duration: 800, delay: 0, order: 2 });
    expect(byName.get("b")).toEqual({ effect: "zoom", start: "with", duration: 300, delay: 200, order: 3 });
    expect(byName.get("c")).toEqual({ effect: "wipe", direction: "top", start: "after", duration: 1200, delay: 0, order: 4 });
    expect(byName.get("d")).toMatchObject({ effect: "appear", start: "click", order: 5 });
    expect(byName.get("e")).toEqual({ effect: "float", start: "click", duration: 500, delay: 100, order: 6 });
  });

  it("知らないプリセットはフェードに寄せ、退場効果と同じ図形の 2 つ目は読まない", async () => {
    const eff = (id: number, cls: string, preset: number, spid: number) =>
      `<p:par><p:cTn id="${id}" presetID="${preset}" presetClass="${cls}" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="${id + 50}" dur="1" fill="hold"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:set></p:childTnLst></p:cTn></p:par>`;
    const timing = `<p:timing><p:tnLst><p:par><p:cTn id="1" nodeType="tmRoot"><p:childTnLst><p:seq><p:cTn id="2" nodeType="mainSeq"><p:childTnLst>${eff(3, "entr", 18, 2)}${eff(4, "exit", 10, 3)}${eff(5, "entr", 10, 2)}</p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
    const result = await pptxWith(box(2, "x") + box(3, "y"), timing);
    const layers = result.slides[0].layers;
    expect(layers.find((l) => l.name === "x")?.animation).toMatchObject({ effect: "fade", start: "click", order: 1 });
    expect(layers.find((l) => l.name === "y")?.animation).toBeUndefined();
  });

  it("グループを対象にした効果は中のレイヤーすべてに付き、2 つ目以降は直前と同時", async () => {
    const grp = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${box(6, "c1")}${box(7, "c2")}</p:grpSp>`;
    const spec = PosterSpecSchema.parse({ meta: {}, layers: [{ id: "g", type: "shape", shape: "rect", animation: a({ effect: "fly", direction: "right" }) }] });
    const timing = buildTimingXml(animationGroups(animationSequence(spec)), new Map([["g", 5]]));
    const result = await pptxWith(grp, timing);
    const [c1, c2] = result.slides[0].layers.filter((l) => l.type !== "background");
    expect(c1.animation).toMatchObject({ effect: "fly", direction: "right", start: "click", order: 1 });
    expect(c2.animation).toMatchObject({ effect: "fly", direction: "right", start: "with", order: 2 });
  });
});
