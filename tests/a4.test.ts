import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { a4Fit, a4Instruction, a4Issues, fitToA4, safeMarginUnits, a4Size, exportPixels, imageDpi, pngA4Report, readPngInfo, setPngDpi } from "../src/editor/a4";
import { PosterSpecSchema } from "../src/schema";
import sample from "../samples/ai-workshop.json";

const poster = (layers: object[], meta: object = {}) => PosterSpecSchema.parse({
  version: 1, meta: { title: "t", width: 1000, height: 1414, ...meta }, theme: "ocean",
  layers: [{ id: "bg", type: "background", fill: "#fff" }, ...layers],
});
const text = (id: string, extra: object = {}) => ({ id, type: "text", text: "こんにちは", x: 100, y: 100, w: 400, h: 60, size: 40, ...extra });

/** 幅 w・高さ h の小さな PNG（中身は 1 行ぶんだけの IDAT） */
function tinyPng(w: number, h: number) {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    return out; // CRC は読み取りでは見ないので 0 のまま
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w); v.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(new Uint8Array(1))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe("a4Fit / a4Size / exportPixels", () => {
  it("1000×1414 は A4 縦、1414×1000 は A4 横", () => {
    expect(a4Fit(1000, 1414)).toMatchObject({ ok: true, orientation: "portrait" });
    expect(a4Fit(1414, 1000)).toMatchObject({ ok: true, orientation: "landscape" });
  });
  it("3:4 や 16:9 は A4 ではない", () => {
    expect(a4Fit(1080, 1440).ok).toBe(false);
    expect(a4Fit(1333, 750).ok).toBe(false);
    expect(a4Fit(1000, 1333).heightMm).toBeCloseTo(279.9, 1);
  });
  it("A4 にそろえると幅はそのまま高さを直す", () => {
    expect(a4Size(1000, 1333)).toEqual({ width: 1000, height: 1414 });
    expect(a4Size(1333, 750)).toEqual({ width: 1333, height: 943 });
  });
  it("A4 の書き出しは 300dpi ちょうどの 2480×3508px", () => {
    expect(exportPixels(1000, 1414)).toEqual({ w: 2480, h: 3508 });
    expect(exportPixels(1414, 1000)).toEqual({ w: 3508, h: 2480 });
    expect(exportPixels(1000, 1333)).toEqual({ w: 2480, h: 3306 });
  });
});

describe("a4Issues", () => {
  it("内側に収まった普通の文字は問題なし", () => {
    expect(a4Issues(poster([text("a")]))).toEqual([]);
  });
  it("端からはみ出した文字は切れる、端に近い文字は余白の注意", () => {
    const kinds = a4Issues(poster([text("cut", { x: 800 }), text("near", { x: 10 })])).map((i) => [i.layerId, i.kind, i.level]);
    expect(kinds).toEqual([["cut", "cut", "error"], ["near", "margin", "warn"]]);
  });
  it("端まで塗り足した図形は注意しないが、ページの外の図形は知らせる", () => {
    const issues = a4Issues(poster([
      { id: "bleed", type: "shape", shape: "rect", x: -20, y: -20, w: 300, h: 300 },
      { id: "away", type: "shape", shape: "rect", x: 1200, y: 100, w: 100, h: 100 },
    ]));
    expect(issues.map((i) => [i.layerId, i.kind])).toEqual([["away", "outside"]]);
  });
  it("飾りの部品は端に寄せてもよいが、QR や文字入りの部品は余白の注意", () => {
    const issues = a4Issues(poster([
      { id: "dots", type: "component", component: "dots", x: 990 - 130, y: 600, w: 130, h: 120 },
      { id: "qr", type: "component", component: "qr", props: { url: "https://example.com" }, x: 50, y: 1266, w: 170, h: 138 },
      { id: "note", type: "component", component: "stickyNote", props: { text: "メモ" }, x: 800, y: 118, w: 190, h: 160 },
    ]));
    expect(issues.map((i) => [i.layerId, i.kind])).toEqual([["qr", "margin"], ["note", "margin"]]);
  });
  it("隠したレイヤーは見ない", () => {
    expect(a4Issues(poster([text("h", { x: 900, visible: false })]))).toEqual([]);
  });
  it("7pt 未満の文字を知らせる（1000 幅で 1 単位 ≒ 0.6pt）", () => {
    expect(a4Issues(poster([text("s", { size: 10 })])).map((i) => i.kind)).toEqual(["small-text"]);
    expect(a4Issues(poster([text("ok", { size: 12 })]))).toEqual([]);
  });
  it("画像の実効解像度が低いと知らせる", () => {
    const img = { id: "img", type: "image", src: "/a.png", x: 100, y: 100, w: 800, h: 600, fit: "cover" };
    expect(a4Issues(poster([img]), new Map([["/a.png", { w: 400, h: 300 }]])).map((i) => i.kind)).toEqual(["low-res"]);
    expect(a4Issues(poster([img]), new Map([["/a.png", { w: 2000, h: 1500 }]]))).toEqual([]);
  });
  it("imageDpi: A4 幅いっぱいの 2480px 画像は 300dpi", () => {
    expect(imageDpi({ w: 1000, h: 500 }, "cover", 1, { w: 2480, h: 1240 }, 0.21)).toBeCloseTo(300, 0);
  });
});

describe("PNG の解像度", () => {
  it("pHYs を書き込むと 300dpi として読め、A4 の実寸になる", () => {
    const png = setPngDpi(tinyPng(2480, 3508), 300);
    const info = readPngInfo(png)!;
    expect(info).toEqual({ w: 2480, h: 3508, dpi: 300 });
    const r = pngA4Report(info);
    expect(r.ok).toBe(true);
    expect(r.wMm).toBeCloseTo(210, 0);
    expect(r.hMm).toBeCloseTo(297, 0);
  });
  it("書き直しても pHYs は 1 つだけ", () => {
    const png = setPngDpi(setPngDpi(tinyPng(10, 10), 72), 300);
    const s = String.fromCharCode(...png);
    expect(s.split("pHYs").length - 1).toBe(1);
    expect(readPngInfo(png)?.dpi).toBe(300);
  });
  it("解像度の無い PNG や大きさの違う PNG は A4 にならない", () => {
    expect(pngA4Report(readPngInfo(tinyPng(2480, 3508))!).ok).toBe(false);
    expect(pngA4Report({ w: 2480, h: 3306, dpi: 300 }).ok).toBe(false);
  });
});

describe("fitToA4", () => {
  it("A4 でなければ高さを A4 にし、縦の位置を配り直す（全面の飾りは伸ばす）", () => {
    const r = fitToA4(poster([
      text("mid", { y: 600, h: 100 }),
      { id: "stars", type: "component", component: "stars", x: 0, y: 0, w: 1000, h: 1333 },
    ], { height: 1333 }));
    expect(r.resized).toBe(true);
    expect(r.spec.meta).toMatchObject({ width: 1000, height: 1414 });
    const [mid, stars] = r.spec.layers.slice(1);
    expect(mid.y + mid.h / 2).toBeCloseTo(650 * 1414 / 1333, 0);
    expect(mid.h).toBe(100);
    expect([stars.y, stars.h]).toEqual([0, 1414]);
  });
  it("文字・QR を端から 5mm 内側に入れ、飾りはそのまま", () => {
    const m = safeMarginUnits(1000, 1414);
    const r = fitToA4(poster([
      text("cut", { x: 800 }),
      { id: "qr", type: "component", component: "qr", props: { url: "x" }, x: 50, y: 1266, w: 170, h: 138 },
      { id: "dots", type: "component", component: "dots", x: 900, y: 10, w: 130, h: 120 },
    ]));
    expect(r.resized).toBe(false);
    const [cut, qr, dots] = r.spec.layers.slice(1);
    expect(cut.x + cut.w).toBe(1000 - m);
    expect(qr.y + qr.h).toBe(1414 - m);
    expect([dots.x, dots.y]).toEqual([900, 10]);
    expect(a4Issues(r.spec).filter((i) => i.kind === "cut" || i.kind === "margin")).toEqual([]);
  });
  it("回転した部品も丸めたあとで内側に残る", () => {
    const s = poster([{ id: "bubble", type: "component", component: "speechBubble", props: { text: "やあ" }, rotation: -10, x: 18, y: 500, w: 290, h: 235 }]);
    expect(a4Issues(fitToA4(s).spec)).toEqual([]);
  });
  it("サンプルのポスターを A4 でない高さにしても、整えると余白の注意がなくなる", () => {
    const s = PosterSpecSchema.parse({ ...sample, meta: { ...sample.meta, height: 1333 } });
    expect(a4Issues(fitToA4(s).spec)).toEqual([]);
  });
  it("入りきらない大きさの文字は縮める", () => {
    const r = fitToA4(poster([text("wide", { x: 0, w: 1100, size: 100 })]));
    const t = r.spec.layers[1] as { x: number; w: number; size: number };
    expect(r.shrunk).toEqual(["wide"]);
    expect(t.w).toBeLessThanOrEqual(1000 - safeMarginUnits(1000, 1414) * 2);
    expect(t.size).toBeLessThan(100);
  });
  it("整っていれば何も変えない", () => {
    const s = poster([text("a")]);
    expect(fitToA4(s).spec).toEqual(s);
  });
  it("AI への指示に余白・文字の大きさ・注意・追加の指示を入れる", () => {
    const s = poster([text("cut", { x: 800 })]);
    const t = a4Instruction(s, a4Issues(s), "タイトルは大きいまま");
    expect(t).toContain(`端から ${safeMarginUnits(1000, 1414)} 以上内側`);
    expect(t).toContain("cut");
    expect(t).toContain("追加の指示: タイトルは大きいまま");
  });
});
