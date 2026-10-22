import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { embedFontFiles } from "../src/render/export";
import { fontInfo, ttfToEot } from "../server/eot";

/** OS/2・name・head だけを持つ最小の TrueType */
function tinyTtf() {
  const name = (() => {
    const strs = ["Test Sans", "Bold", "Version 1.0", "Test Sans Bold"].map((s) => Buffer.from(s, "utf16le").swap16());
    const head = Buffer.alloc(6 + strs.length * 12);
    head.writeUInt16BE(strs.length, 2);
    head.writeUInt16BE(head.length, 4);
    let off = 0;
    [1, 2, 5, 4].forEach((id, i) => {
      const r = 6 + i * 12;
      head.writeUInt16BE(3, r); head.writeUInt16BE(1, r + 2); head.writeUInt16BE(0x409, r + 4); head.writeUInt16BE(id, r + 6);
      head.writeUInt16BE(strs[i].length, r + 8); head.writeUInt16BE(off, r + 10);
      off += strs[i].length;
    });
    return Buffer.concat([head, ...strs]);
  })();
  const os2 = Buffer.alloc(86);
  os2.writeUInt16BE(1, 0); os2.writeUInt16BE(700, 4); os2.writeUInt16BE(0, 8);
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x12345678, 8);
  const tables = [["OS/2", os2], ["head", head], ["name", name]] as const;
  const dir = Buffer.alloc(12 + tables.length * 16);
  dir.writeUInt32BE(0x00010000, 0); dir.writeUInt16BE(tables.length, 4);
  let off = dir.length;
  tables.forEach(([tag, data], i) => {
    const p = 12 + i * 16;
    dir.write(tag, p, "latin1"); dir.writeUInt32BE(off, p + 8); dir.writeUInt32BE(data.length, p + 12);
    off += data.length;
  });
  return Buffer.concat([dir, ...tables.map(([, d]) => d)]);
}

describe("EOT", () => {
  it("TTF を圧縮なしの EOT で包む", () => {
    const ttf = tinyTtf();
    expect(fontInfo(ttf)).toMatchObject({ familyName: "Test Sans", styleName: "Bold", fsType: 0 });
    const eot = ttfToEot(ttf);
    expect(eot.readUInt32LE(0)).toBe(eot.length);
    expect(eot.readUInt32LE(4)).toBe(ttf.length);
    expect(eot.readUInt32LE(8)).toBe(0x00020001);
    expect(eot.readUInt32LE(12)).toBe(0);
    expect(eot.readUInt32LE(28)).toBe(700);
    expect(eot.readUInt16LE(34)).toBe(0x504c);
    expect(eot.readUInt32LE(60)).toBe(0x12345678);
    const familySize = eot.readUInt16LE(82);
    expect(eot.toString("utf16le", 84, 84 + familySize)).toBe("Test Sans");
    expect(eot.subarray(eot.length - ttf.length).equals(ttf)).toBe(true);
  });
});

describe("PPTX へのフォント埋め込み", () => {
  it("fntdata・関係・コンテンツタイプ・embeddedFontLst を足す", async () => {
    const pptx = new PptxGenJS();
    pptx.addSlide().addText("テスト", { x: 0, y: 0, w: 1, h: 1, fontFace: "Noto Sans JP" });
    const zip = await JSZip.loadAsync((await pptx.write({ outputType: "nodebuffer" })) as Buffer);
    const data = Buffer.from("font").toString("base64");
    await embedFontFiles(zip, [
      { family: "Noto Sans JP", bold: false, data },
      { family: "Noto Sans JP", bold: true, data },
    ]);
    const pres = await zip.file("ppt/presentation.xml")!.async("string");
    const root = pres.match(/<p:presentation\b[^>]*>/)![0];
    expect(root).toContain('embedTrueTypeFonts="1"');
    expect(root.match(/saveSubsetFonts=/g)).toHaveLength(1);
    expect(pres).toMatch(/<p:notesSz [^>]*\/><p:embeddedFontLst><p:embeddedFont><p:font typeface="Noto Sans JP"[^>]*\/><p:regular r:id="rIdFont1"\/><p:bold r:id="rIdFont2"\/><\/p:embeddedFont><\/p:embeddedFontLst>/);
    const rels = await zip.file("ppt/_rels/presentation.xml.rels")!.async("string");
    expect(rels).toContain('Id="rIdFont2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font2.fntdata"');
    expect(await zip.file("[Content_Types].xml")!.async("string")).toContain('Extension="fntdata"');
    expect(await zip.file("ppt/fonts/font1.fntdata")!.async("string")).toBe("font");
  });
});
