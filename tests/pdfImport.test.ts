import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { importPdf } from "../src/import/pdf";

beforeAll(async () => {
  // @ts-expect-error PDF.js は worker の型定義を配布していない。
  Object.assign(globalThis, { pdfjsWorker: await import("pdfjs-dist/legacy/build/pdf.worker.mjs") });
});
afterEach(() => vi.unstubAllGlobals());

function pdfFile(pages = 1, text = true, renderingMode = 0, extra: "none" | "transparent" | "overpaint" | "separate-paint" | "smask-none" = "none") {
  const content = `0 0 1 rg 20 20 100 100 re f\n${extra === "transparent" ? "/GS1 gs\n" : extra === "smask-none" ? "/GS2 gs\n" : ""}${text ? `1 0 0 rg BT /F1 24 Tf ${renderingMode} Tr 20 200 Td (Edit me) Tj ET\n` : ""}${extra === "overpaint" ? "1 1 1 rg 10 190 180 50 re f\n" : extra === "separate-paint" ? "0 1 0 rg 200 20 20 20 re f\n" : ""}`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ")}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 500] /Resources << /Font << /F1 ${pages + 4} 0 R >> /ExtGState << /GS1 << /ca 0 >> /GS2 << /SMask /None /ca 1 >> >> >> /Contents ${pages + 3} 0 R >>`),
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let data = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => { const pos = data.length; data += `${i + 1} 0 obj\n${o}\nendobj\n`; return pos; });
  const xref = data.length;
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new File([data], "document.pdf", { type: "application/pdf" });
}

function canvasDocument() {
  vi.stubGlobal("document", { createElement: () => {
    const canvas = createCanvas(1, 1);
    return Object.assign(canvas, { toBlob: (callback: (blob: Blob) => void) => callback(new Blob([new Uint8Array(canvas.toBuffer("image/png"))], { type: "image/png" })) });
  } });
}

describe("PDFを編集用に読み込む", () => {
  it("文字と図形を独立した部品にし、背景へ一枚化しない", async () => {
    canvasDocument();
    const upload = vi.fn(async () => "/generated/pdf.png");
    const result = await importPdf(pdfFile(), { onImage: upload });
    const layers = result.slides[0].layers;
    expect(result.name).toBe("document");
    expect(result.warnings).toEqual([]);
    expect(layers).toHaveLength(3);
    // PDF の暗黙の白地は背景レイヤーにする（書き出しが透明にならないように）
    expect(layers[0]).toMatchObject({ type: "background", fill: "#ffffff", x: 0, y: 0, w: 1000 });
    expect(layers[1]).toMatchObject({ type: "shape", fill: "#0000ff" });
    expect(layers[1].locked).not.toBe(true);
    expect(layers[2]).toMatchObject({ type: "text", text: "Edit me", fill: "#ff0000", align: "left", weight: 400 });
    expect(layers[2].x).toBeCloseTo(20 * 1000 / 300);
    expect(upload).not.toHaveBeenCalled();
  });

  it("複数ページを順番どおりに変換し、進捗を通知する", async () => {
    canvasDocument();
    const progress = vi.fn();
    const result = await importPdf(pdfFile(2), { onImage: async () => "/generated/page.png", onProgress: progress });
    expect(result.slides.map((s) => s.meta.title)).toEqual(["document — 1ページ", "document — 2ページ"]);
    expect(progress).toHaveBeenLastCalledWith(2, 2);
  });

  it.each([[true, 3], [true, 7]] as const)("不可視文字・クリップ文字は安全にページ画像として保持する（文字:%s モード:%s）", async (text, mode) => {
    canvasDocument();
    const result = await importPdf(pdfFile(1, text, mode), { onImage: async () => "/generated/page.png" });
    expect(result.slides[0].layers).toHaveLength(1);
    expect(result.warnings[0]).toContain("元の文字は直接編集できません");
  });

  it("20ページ超過は保存前に拒否する", async () => {
    const upload = vi.fn();
    await expect(importPdf(pdfFile(21), { onImage: upload })).rejects.toThrow("20 ページまで");
    expect(upload).not.toHaveBeenCalled();
  });

  it("透明な文字を可視化しない", async () => {
    canvasDocument();
    const result = await importPdf(pdfFile(1, true, 0, "transparent"), { onImage: async () => "/generated/page.png" });
    expect(result.slides[0].layers).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it("後から描いた図形は文字より前面に配置する", async () => {
    canvasDocument();
    const result = await importPdf(pdfFile(1, true, 0, "overpaint"), { onImage: async () => "/generated/page.png" });
    expect(result.slides[0].layers.map((l) => l.type)).toEqual(["background", "shape", "text", "shape"]);
    expect(result.slides[0].layers.at(-1)).toMatchObject({ type: "shape", fill: "#ffffff" });
  });

  it("文字のないベクターPDFも図形として選択できる", async () => {
    canvasDocument();
    const result = await importPdf(pdfFile(1, false), { onImage: async () => "/generated/page.png" });
    expect(result.slides[0].layers[1].type).toBe("shape");
    expect(result.warnings[0]).toContain("文字データがありません");
  });

  it("/SMask /None（マスク無し）の描画状態があっても文字と図形を部品にする", async () => {
    canvasDocument();
    const upload = vi.fn(async () => "/generated/pdf.png");
    const result = await importPdf(pdfFile(1, true, 0, "smask-none"), { onImage: upload });
    expect(result.warnings).toEqual([]);
    expect(result.slides[0].layers.map((l) => l.type)).toEqual(["background", "shape", "text"]);
    expect(upload).not.toHaveBeenCalled();
  });

  it("後から描く図形でも文字と重ならなければ文字を編集可能にする", async () => {
    canvasDocument();
    const result = await importPdf(pdfFile(1, true, 0, "separate-paint"), { onImage: async () => "/generated/page.png" });
    expect(result.slides[0].layers.some((l) => l.type === "text")).toBe(true);
  });
});
