import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { createCanvas } from "@napi-rs/canvas";
import JSZip from "jszip";
import { importPptx } from "../src/import/pptx";

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

async function pptxWith(body: string) {
  const zip = new JSZip();
  zip.file("ppt/presentation.xml", `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="4572000"/></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`);
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
