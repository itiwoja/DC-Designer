import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildImagePdf, pageSizePt, rgbaToRgbOnWhite } from "../src/render/pdf";

const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

describe("rgbaToRgbOnWhite", () => {
  it("不透明はそのまま、透明は白、半透明は白地に合成する", () => {
    const rgba = new Uint8Array([10, 20, 30, 255, 0, 0, 0, 0, 0, 0, 0, 128]);
    expect([...rgbaToRgbOnWhite(rgba)]).toEqual([10, 20, 30, 255, 255, 255, 127, 127, 127]);
  });
});

describe("pageSizePt", () => {
  it("A4 に 0.5mm 以内なら A4 ちょうど（横向きも）、そうでなければ実寸のまま", () => {
    const a4 = { w: 595.276, h: 841.89 };
    const round = (p: { w: number; h: number }) => ({ w: Math.round(p.w * 1000) / 1000, h: Math.round(p.h * 1000) / 1000 });
    expect(round(pageSizePt(209.97, 297.01))).toEqual(a4);
    expect(round(pageSizePt(297.01, 209.97))).toEqual({ w: a4.h, h: a4.w });
    expect(round(pageSizePt(210, 200))).toEqual({ w: a4.w, h: 566.929 });
  });
});

describe("buildImagePdf", () => {
  it("A4 300dpi の画像を A4 ちょうど（595.276×841.89pt）の 1 ページにし、画素を可逆で埋め込む", async () => {
    const w = 2480, h = 3508;
    const rgb = new Uint8Array(w * h * 3);
    rgb[0] = 200; rgb[rgb.length - 1] = 7;
    const blob = await buildImagePdf(rgb, w, h, 300, "夏祭り");
    expect(blob.type).toBe("application/pdf");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const s = text(bytes);
    expect(s.startsWith("%PDF-1.4\n")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(s).toContain("/MediaBox [0 0 595.276 841.89]");
    expect(s).toContain(`/Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`);
    // タイトルは UTF-16BE（夏祭り = 590F 796D 308A）
    expect(s).toContain("/Title <FEFF590F796D308A>");

    // 相互参照表の位置が各オブジェクトの先頭を指している
    const startxref = Number(/startxref\n(\d+)\n/.exec(s)![1]);
    expect(s.slice(startxref, startxref + 4)).toBe("xref");
    const offsets = [...s.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(6);
    offsets.forEach((off, i) => expect(s.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));

    // 画像のストリームを展開すると元の画素に戻る
    const len = Number(/\/Image .*?\/Length (\d+) >>/.exec(s)![1]);
    const start = s.indexOf("stream\n", s.indexOf("/Subtype /Image")) + "stream\n".length;
    const raw = inflateSync(bytes.subarray(start, start + len));
    expect(raw.length).toBe(rgb.length);
    expect(raw[0]).toBe(200);
    expect(raw[raw.length - 1]).toBe(7);
  });
  it("画素の数が大きさと合わなければ止める", async () => {
    await expect(buildImagePdf(new Uint8Array(5), 2, 1, 300)).rejects.toThrow();
  });
});
