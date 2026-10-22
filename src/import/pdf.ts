import type { TextItem, PDFOperatorList } from "pdfjs-dist/types/src/display/api";
import { MAX_REFERENCES } from "../referenceLimits";
import { PosterSpecSchema, type Layer, type PosterSpec } from "../schema";
import { readPdf } from "./pdfDocument";
import { extractPdfGraphics } from "./pdfGraphics";

type PdfImportOptions = {
  onImage: (blob: Blob, mediaType: string) => Promise<string>;
  onProgress?: (done: number, total: number) => void;
};
export type PdfImportResult = { name: string; slides: PosterSpec[]; warnings: string[] };

/** 対応できる描画は元の順序で部品化し、複雑なページは見た目を保持して読み込む。 */
export async function importPdf(file: File, opts: PdfImportOptions): Promise<PdfImportResult> {
  return readPdf(file, async (pdf) => {
    if (pdf.numPages > MAX_REFERENCES) throw new Error(`PDFは ${MAX_REFERENCES} ページまで読み込めます（このPDFは ${pdf.numPages} ページ）`);
    const { OPS, Util } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const name = file.name.replace(/\.pdf$/i, "") || "PDF";
    const slides: PosterSpec[] = [], warnings: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      opts.onProgress?.(n - 1, pdf.numPages);
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1000 / base.width, 2000 / base.height) });
      const width = Math.round(viewport.width), height = Math.round(viewport.height);
      const content = await page.getTextContent();
      const items = content.items.filter((t): t is TextItem => "str" in t && !!t.str.trim());
      const operators = await page.getOperatorList();
      // 文字で画像を切り抜くPDF・縦書き・不可視OCR文字は、文字を除くと見た目が壊れるため画像で保持する。
      // /SMask /None（Illustrator・Chrome の印刷などが常に出す）は pdf.js から false で届くので、マスク無しとして通す
      const unsafeText = items.some((t) => content.styles[t.fontName]?.vertical) || operators.fnArray.some((op, i) =>
        (op === OPS.setTextRenderingMode && operators.argsArray[i][0] !== 0) ||
        (op === OPS.setGState && operators.argsArray[i][0].some(([key, value]: [string, unknown]) =>
          ((key === "ca" || key === "CA") && value !== 1) || (key === "SMask" && value !== false && value !== "None"))),
      );
      let imageOnly = !items.length || unsafeText;
      const colors = textColors(operators, OPS);
      const textLayers: Layer[] = [];
      const orderedText: { index: number; layer: Layer }[] = [];
      let canOrderText = true;
      let cursor = 0;
      if (!imageOnly) for (const item of items) {
        const tx = Util.transform(viewport.transform, item.transform);
        const size = Math.hypot(tx[2], tx[3]), angle = Math.atan2(tx[1], tx[0]);
        const w = Math.max(item.width * viewport.scale, size * 0.2), h = size * 1.3;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const left = tx[4] + size * 0.88 * sin, top = tx[5] - size * 0.88 * cos;
        const found = colors.text.indexOf(item.str, cursor);
        const run = colors.runs.find((r) => found >= r.start && found < r.end);
        const fill = run?.color ?? "#000000";
        if (!run) canOrderText = false;
        if (found >= 0) cursor = found + item.str.length;
        textLayers.push({
          id: `pdf-text-${n}-${textLayers.length + 1}`, name: item.str.slice(0, 40), type: "text", text: item.str,
          x: left - w / 2 + w / 2 * cos - h / 2 * sin,
          y: top - h / 2 + w / 2 * sin + h / 2 * cos,
          w, h, size, rotation: angle * 180 / Math.PI,
          font: content.styles[item.fontName]?.fontFamily ?? "sans-serif", weight: 400,
          lineHeight: 1, fill, fit: "shrink", align: "left",
        });
        if (run) orderedText.push({ index: run.index, layer: textLayers[textLayers.length - 1] });
      }
      // パス配列はrenderでPath2Dに変わるため、画像を描画する前に部品を取り出す。
      if (!unsafeText && canOrderText) {
        const graphics = await extractPdfGraphics(page, operators, viewport, opts);
        if (graphics.supported && (graphics.parts.length || textLayers.length)) {
          // PDF の暗黙の白地を背景レイヤーにする（無いと PNG / PPTX の書き出しが透明になり、エディターの見た目と食い違う）
          const background: Layer = { id: `pdf-bg-${n}`, name: "背景", type: "background", fill: "#ffffff", x: 0, y: 0, w: width, h: height };
          const layers = [background, ...[...graphics.parts, ...orderedText].sort((a, b) => a.index - b.index).map((p) => p.layer)];
          slides.push(PosterSpecSchema.parse({ meta: { title: pdf.numPages === 1 ? name : `${name} — ${n}ページ`, width, height }, theme: "ocean", layers }));
          if (!textLayers.length) warnings.push(`${n}ページ目には編集可能な文字データがありません。図形・画像は個別に選択できます。`);
          page.cleanup();
          opts.onProgress?.(n, pdf.numPages);
          continue;
        }
      }
      const canvas = document.createElement("canvas");
      try {
        canvas.width = Math.ceil(viewport.width * 1.5);
        canvas.height = Math.ceil(viewport.height * 1.5);
        await page.render({
          canvas, viewport: page.getViewport({ scale: viewport.scale * 1.5 }),
          background: "rgb(255,255,255)", recordOperations: !imageOnly,
        }).promise;
        // 後から図や画像で覆われた文字を、前面の編集文字として復活させない。
        if (!imageOnly) imageOnly = hasTextOverpaint(operators, page.recordedBBoxes, OPS);
        if (!imageOnly) {
          canvas.width = canvas.width;
          await page.render({
            canvas, viewport: page.getViewport({ scale: viewport.scale * 1.5 }), background: "rgb(255,255,255)",
            operationsFilter: (index, list) => list.fnArray[index] !== OPS.showText,
          }).promise;
        } else {
          textLayers.length = 0;
          warnings.push(`${n}ページ目はページ画像として読み込んだため、元の文字は直接編集できません。文字・画像の追加はできます。`);
        }
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error(`${n}ページ目の画像を作れませんでした`)), "image/png"));
        const src = await opts.onImage(blob, "image/png");
        slides.push(PosterSpecSchema.parse({
          meta: { title: pdf.numPages === 1 ? name : `${name} — ${n}ページ`, width, height }, theme: "ocean",
          layers: [{ id: `pdf-page-${n}`, name: "PDFの背景（図・写真）", type: "image", src, x: 0, y: 0, w: width, h: height, fit: "contain", locked: true }, ...textLayers],
        }));
      } finally {
        canvas.width = canvas.height = 0;
        page.cleanup();
      }
      opts.onProgress?.(n, pdf.numPages);
    }
    return { name, slides, warnings };
  });
}

type BBoxes = { isEmpty: (index: number) => boolean; minX: (index: number) => number; minY: (index: number) => number; maxX: (index: number) => number; maxY: (index: number) => number };
function hasTextOverpaint(list: PDFOperatorList, boxes: BBoxes | null, ops: Record<string, number>) {
  if (!boxes) return true;
  const paints = new Set([ops.stroke, ops.closeStroke, ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke, ops.shadingFill, ops.constructPath, ops.rawFillPath,
    ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageMaskXObject, ops.paintImageMaskXObjectGroup, ops.paintInlineImageXObjectGroup, ops.paintImageXObjectRepeat, ops.paintImageMaskXObjectRepeat, ops.paintSolidColorImageMask]);
  const text: number[] = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    if (boxes.isEmpty(i)) continue;
    if (list.fnArray[i] === ops.showText) text.push(i);
    else if (paints.has(list.fnArray[i]) && text.some((t) => boxes.minX(t) < boxes.maxX(i) && boxes.maxX(t) > boxes.minX(i) && boxes.minY(t) < boxes.maxY(i) && boxes.maxY(t) > boxes.minY(i))) return true;
  }
  return false;
}

/** getTextContent に無い色を、文字描画演算の順番から対応付ける。 */
function textColors(list: PDFOperatorList, ops: Record<string, number>) {
  let color = "#000000", text = "";
  const stack: string[] = [], runs: { start: number; end: number; color: string; index: number }[] = [];
  list.fnArray.forEach((op, i) => {
    const args = list.argsArray[i];
    if (op === ops.save) stack.push(color);
    else if (op === ops.restore) color = stack.pop() ?? "#000000";
    else if (op === ops.setFillRGBColor) {
      color = typeof args[0] === "string" ? args[0] : `#${Array.from(args as number[]).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
    } else if (op === ops.showText) {
      const value = (args[0] as ({ unicode?: string } | number)[]).map((g) => typeof g === "object" ? g.unicode ?? "" : "").join("");
      runs.push({ start: text.length, end: text.length + value.length, color, index: i });
      text += value;
    }
  });
  return { text, runs };
}
