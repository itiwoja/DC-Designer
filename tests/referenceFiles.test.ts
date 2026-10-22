import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { readReferenceFile } from "../src/editor/referenceFiles";
import { MAX_REFERENCE_FILE_BYTES } from "../src/referenceLimits";

// 実際の PDF パーサーと描画処理を使い、ブラウザの canvas だけを置き換える。
beforeAll(async () => {
  // @ts-expect-error PDF.js は worker の型定義を配布していない。
  Object.assign(globalThis, { pdfjsWorker: await import("pdfjs-dist/legacy/build/pdf.worker.mjs") });
});
afterEach(() => vi.unstubAllGlobals());

function pdfFile(pages = 2) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ")}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 500] /Resources << >> /Contents ${pages + 3} 0 R >>`),
    "<< /Length 26 >>\nstream\n1 0 0 rg 20 20 100 100 re f\nendstream",
  ];
  let text = "%PDF-1.4\n";
  const offsets = objects.map((obj, i) => { const offset = text.length; text += `${i + 1} 0 obj\n${obj}\nendobj\n`; return offset; });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new File([text], "資料.pdf", { type: "application/pdf" });
}

describe("PDFの参考添付", () => {
  it("複数ページを実際に描画し、ページ順と縦横比を保つ", async () => {
    vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
    const pages = await readReferenceFile(pdfFile());
    expect(pages.map((p) => p.name)).toEqual(["資料.pdf (1/2)", "資料.pdf (2/2)"]);
    for (const page of pages) {
      expect(page.img.mediaType).toBe("image/jpeg");
      expect(page.url).toBe(`data:image/jpeg;base64,${page.img.data}`);
      const { loadImage } = await import("@napi-rs/canvas");
      const image = await loadImage(Buffer.from(page.img.data, "base64"));
      expect([image.width, image.height]).toEqual([600, 1000]);
    }
  });

  it("ページ超過を切り捨てずに拒否する", async () => {
    await expect(readReferenceFile(pdfFile(), 1)).rejects.toThrow("2 ページあります");
  });

  it("壊れたPDFに読み直せるエラーを出す", async () => {
    await expect(readReferenceFile(new File(["invalid"], "broken.pdf"))).rejects.toThrow("PDFを読み込めません");
  });

  it("20MB超過・添付上限・未対応形式を読み込み前に拒否する", async () => {
    const large = new File([new Uint8Array(MAX_REFERENCE_FILE_BYTES + 1)], "large.pdf");
    await expect(readReferenceFile(large)).rejects.toThrow("20MB");
    await expect(readReferenceFile(pdfFile(), 0)).rejects.toThrow("20 枚まで");
    await expect(readReferenceFile(new File(["x"], "x.txt", { type: "text/plain" }))).rejects.toThrow("PDF を選んで");
  });
});
