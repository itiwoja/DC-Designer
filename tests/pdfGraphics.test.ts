import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { PDFOperatorList, PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractPdfGraphics } from "../src/import/pdfGraphics";

const viewport = { transform: [2, 0, 0, -2, 0, 400] } as any;
const page = { pageNumber: 1 } as PDFPageProxy;
const path = (paint = OPS.fill) => [paint, [new Float32Array([0, 10, 20, 1, 30, 20, 1, 30, 40, 4])], [10, 20, 30, 40]];
const operators = (...entries: [number, any[]][]) => ({ fnArray: entries.map(([op]) => op), argsArray: entries.map(([, args]) => args) }) as PDFOperatorList;
const opts = { onImage: async () => "/image.png" };
afterEach(() => vi.unstubAllGlobals());

describe("PDFの独立した図形と画像", () => {
  it("PDF.jsの未描画constructPathからCTM・上下反転・色・重ね順を保持する", async () => {
    const result = await extractPdfGraphics(page, operators(
      [OPS.setFillRGBColor, ["#123456"]], [OPS.transform, [1, 0, 0, 1, 5, 10]],
      [OPS.constructPath, path()], [OPS.showText, [[{ unicode: "text" }]]],
      [OPS.constructPath, path(OPS.eoFill)],
    ), viewport, opts);
    expect(result.supported).toBe(true);
    expect(result.parts.map((p) => p.index)).toEqual([2, 4]);
    expect(result.parts[0].layer).toMatchObject({ type: "shape", shape: "path", x: 30, y: 300, w: 40, h: 40,
      fill: "#123456", d: "M0 1 L1 1 L1 0 Z", fillRule: "nonzero" });
    expect(result.parts[1].layer).toMatchObject({ fillRule: "evenodd" });
  });

  it("save/restoreと線幅・透明度を保持する", async () => {
    const result = await extractPdfGraphics(page, operators(
      [OPS.save, []], [OPS.transform, [3, 0, 0, 3, 0, 0]], [OPS.setLineWidth, [2]],
      [OPS.setStrokeRGBColor, ["#ff0000"]], [OPS.setGState, [[["CA", 0.4]]]],
      [OPS.constructPath, path(OPS.stroke)], [OPS.restore, []], [OPS.constructPath, path(OPS.stroke)],
    ), viewport, opts);
    expect(result.supported).toBe(true);
    expect(result.parts[0].layer).toMatchObject({ stroke: "#ff0000", strokeWidth: 12, opacity: 0.4 });
    expect(result.parts[1].layer).toMatchObject({ stroke: "#000000", strokeWidth: 2, opacity: 1 });
  });

  it("ベジェ・二次曲線の制御点も座標変換する", async () => {
    const result = await extractPdfGraphics(page, operators([OPS.constructPath,
      [OPS.fill, [new Float32Array([0, 0, 0, 2, 10, 0, 20, 10, 20, 20, 3, 10, 20, 0, 0, 4])], [0, 0, 20, 20]]]), viewport, opts);
    expect(result.supported).toBe(true);
    expect(result.parts[0].layer).toMatchObject({ d: "M0 1 C0.5 1 1 0.5 1 0 Q0.5 0 0 1 Z" });
  });

  it.each([
    { points: [0, 10, 20, 1, 30, 20], box: { x: 20, y: 358, w: 40, h: 4, d: "M0 0.5 L1 0.5" } },
    { points: [0, 10, 20, 1, 10, 40], box: { x: 18, y: 320, w: 4, h: 40, d: "M0.5 1 L0.5 0" } },
  ])("水平・垂直罫線の選択枠に線幅を持たせる: $points", async ({ points, box }) => {
    const result = await extractPdfGraphics(page, operators([OPS.setLineWidth, [2]],
      [OPS.constructPath, [OPS.stroke, [new Float32Array(points)], [10, 20, 30, 40]]]), viewport, opts);
    expect(result.supported).toBe(true);
    expect(result.parts[0].layer).toMatchObject({ ...box, strokeWidth: 4 });
  });

  it.each([
    [[OPS.clip, []]], [[OPS.shadingFill, ["shade"]]], [[OPS.paintImageMaskXObject, [{}]]],
    [[OPS.setGState, [[["SMask", true]]]]], [[OPS.setDash, [[3, 2], 0]], [OPS.constructPath, path(OPS.stroke)]],
    [[OPS.transform, [2, 0, 0, 1, 0, 0]], [OPS.constructPath, path(OPS.stroke)]],
  ] as [number, any[]][][])("未対応描画を黙って消さずfallback対象にする: %j", async (...entries) => {
    const result = await extractPdfGraphics(page, operators(...entries), viewport, opts);
    expect(result.supported).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it.each([1, 2, 3])("画像kind%sをPNGとして個別保存し回転と位置を保持する", async (kind) => {
    vi.stubGlobal("document", { createElement: () => {
      const canvas = createCanvas(1, 1);
      return Object.assign(canvas, { toBlob: (cb: (b: Blob) => void) => cb(new Blob([new Uint8Array(canvas.toBuffer("image/png"))], { type: "image/png" })) });
    } });
    const image = { width: 1, height: 1, kind, data: new Uint8Array(kind === 1 ? [128] : kind === 2 ? [255, 0, 0] : [255, 0, 0, 128]) };
    const save = vi.fn(async (blob: Blob) => {
      const decoded = await loadImage(Buffer.from(await blob.arrayBuffer()));
      const canvas = createCanvas(1, 1), ctx = canvas.getContext("2d"); ctx.drawImage(decoded, 0, 0);
      expect([...ctx.getImageData(0, 0, 1, 1).data]).toEqual(kind === 1 ? [255, 255, 255, 255] : kind === 2 ? [255, 0, 0, 255] : [255, 0, 0, 128]);
      return "/asset.png";
    });
    const result = await extractPdfGraphics(page, operators([OPS.transform, [0, 20, -10, 0, 30, 40]], [OPS.paintInlineImageXObject, [image]]), viewport, { onImage: save });
    expect(result.supported).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(result.parts[0]).toMatchObject({ index: 1, layer: { type: "image", src: "/asset.png", x: 30, y: 290, w: 40, h: 20, rotation: -90 } });
  });

  it("共通画像リソースをcallbackで解決する", async () => {
    const canvas = createCanvas(1, 1);
    Object.assign(canvas, { toBlob: (cb: (b: Blob) => void) => cb(new Blob([new Uint8Array(canvas.toBuffer("image/png"))])) });
    vi.stubGlobal("document", { createElement: () => canvas });
    const get = vi.fn((_id, callback) => callback({ width: 1, height: 1, bitmap: createCanvas(1, 1) }));
    const result = await extractPdfGraphics({ pageNumber: 1, commonObjs: { get } } as any,
      operators([OPS.paintImageXObject, ["g_image"]]), viewport, opts);
    expect(result.supported).toBe(true);
    expect(get).toHaveBeenCalledWith("g_image", expect.any(Function));
    expect(result.parts).toHaveLength(1);
  });
});
