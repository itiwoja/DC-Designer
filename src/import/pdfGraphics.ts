import type { PDFOperatorList, PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import type { Layer } from "../schema";

type Matrix = number[];
type State = { matrix: Matrix; fill: string; stroke: string; width: number; fillAlpha: number; strokeAlpha: number; dash: boolean; cap: number; join: number };

/** render() が constructPath の配列を Path2D に置き換える前に呼ぶ。 */
export async function extractPdfGraphics(page: PDFPageProxy, operators: PDFOperatorList, viewport: PageViewport,
  opts: { onImage: (blob: Blob, mediaType: string) => Promise<string> },
): Promise<{ parts: { index: number; layer: Layer }[]; supported: boolean; warnings: string[] }> {
  const { OPS, Util } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const parts: { index: number; layer: Layer }[] = [], warnings: string[] = [];
  const unsupported = (reason: string) => { if (!warnings.includes(reason)) warnings.push(reason); };
  let state: State = { matrix: [1, 0, 0, 1, 0, 0], fill: "#000000", stroke: "#000000", width: 1, fillAlpha: 1, strokeAlpha: 1, dash: false, cap: 0, join: 0 };
  const stack: State[] = [];
  const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const evenOps = new Set([OPS.eoFill, OPS.eoFillStroke, OPS.closeEOFillStroke]);
  const ignored = new Set([OPS.dependency, OPS.setRenderingIntent, OPS.setFlatness, OPS.setMiterLimit,
    OPS.beginText, OPS.endText, OPS.setCharSpacing, OPS.setWordSpacing, OPS.setHScale, OPS.setLeading, OPS.setFont,
    OPS.setTextRenderingMode, OPS.setTextRise, OPS.moveText, OPS.setLeadingMoveText, OPS.setTextMatrix, OPS.nextLine,
    OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText, OPS.setCharWidth, OPS.setCharWidthAndBounds,
    OPS.markPoint, OPS.markPointProps, OPS.beginMarkedContent, OPS.endMarkedContent, OPS.beginCompat, OPS.endCompat, OPS.endPath]);
  for (let index = 0; index < operators.fnArray.length; index++) {
    const op = operators.fnArray[index], args = operators.argsArray[index];
    if (op === OPS.save) stack.push({ ...state, matrix: [...state.matrix] });
    else if (op === OPS.restore) {
      const saved = stack.pop();
      if (saved) state = saved; else unsupported("PDFの描画状態を復元できません");
    } else if (op === OPS.transform) state.matrix = Util.transform(state.matrix, args);
    else if (op === OPS.setFillRGBColor) state.fill = args[0];
    else if (op === OPS.setStrokeRGBColor) state.stroke = args[0];
    else if (op === OPS.setFillTransparent) state.fill = "transparent";
    else if (op === OPS.setStrokeTransparent) state.stroke = "transparent";
    else if (op === OPS.setLineWidth) state.width = args[0];
    else if (op === OPS.setLineCap) state.cap = args[0];
    else if (op === OPS.setLineJoin) state.join = args[0];
    else if (op === OPS.setDash) state.dash = args[0].length > 0;
    else if (op === OPS.setGState) {
      for (const [key, value] of args[0]) {
        if (key === "ca") state.fillAlpha = value;
        else if (key === "CA") state.strokeAlpha = value;
        else if (key === "LW") state.width = value;
        else if (key === "LC") state.cap = value;
        else if (key === "LJ") state.join = value;
        else if (key === "D") state.dash = value[0].length > 0;
        else if (key === "SMask" && (value === false || value === "None")) continue;
        else if (key === "BM" && value === "source-over") continue;
        else if (key === "ML" || key === "Font") continue;
        else unsupported(`未対応のPDF描画状態: ${key}`);
      }
    } else if (op === OPS.constructPath) {
      const [paint, data] = args, fill = fillOps.has(paint), stroke = strokeOps.has(paint);
      if (!fill && !stroke) { if (paint !== OPS.endPath) unsupported(`未対応のPDFパス描画: ${paint}`); continue; }
      const rawPath = data?.[0];
      if (!Array.isArray(rawPath) && !(rawPath instanceof Float32Array)) { unsupported("PDFパスが既に描画済みです"); continue; }
      const path: ArrayLike<number> = rawPath;
      const matrix = Util.transform(viewport.transform, state.matrix);
      const sx = Math.hypot(matrix[0], matrix[1]), sy = Math.hypot(matrix[2], matrix[3]);
      if (stroke && state.width === 0) unsupported("デバイス依存の極細線を含むPDF");
      if (stroke && (Math.abs(sx - sy) > 1e-5 * Math.max(sx, sy) || Math.abs(matrix[0] * matrix[2] + matrix[1] * matrix[3]) > 1e-5 * sx * sy)) unsupported("非等方変形されたPDFの線");
      if (stroke && (state.dash || state.cap !== 0 || state.join !== 0)) unsupported("破線・線端・線結合のあるPDFの線");
      if (fill && stroke && state.fillAlpha !== state.strokeAlpha) unsupported("塗りと線の透明度が異なるPDF図形");
      const commands: { command: string; points: number[] }[] = [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let p = 0; p < path.length;) {
        const code = path[p++], count = [2, 2, 6, 4, 0][code];
        if (count === undefined || p + count > path.length) { unsupported("未対応のPDFパス命令"); break; }
        const points: number[] = [];
        for (let j = 0; j < count; j += 2) {
          const x = path[p++], y = path[p++];
          const px = matrix[0] * x + matrix[2] * y + matrix[4], py = matrix[1] * x + matrix[3] * y + matrix[5];
          points.push(px, py);
          minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
        }
        commands.push({ command: ["M", "L", "C", "Q", "Z"][code], points });
      }
      if (minX === Infinity) continue;
      if (![minX, minY, maxX, maxY].every(Number.isFinite)) { unsupported("PDF図形の座標が不正です"); continue; }
      // 細い罫線にも選択用の枠を持たせ、パスはその中央に置く。
      if (stroke && state.width > 0) {
        const width = state.width * sx;
        if (maxX - minX < 0.001) { minX -= width / 2; maxX += width / 2; }
        if (maxY - minY < 0.001) { minY -= width / 2; maxY += width / 2; }
      }
      const x = minX, y = minY, w = Math.max(0.001, maxX - x), h = Math.max(0.001, maxY - y);
      const d = commands.map((c) => c.command + c.points.map((v, i) => Number(((v - (i % 2 ? y : x)) / (i % 2 ? h : w)).toFixed(8))).join(" ")).join(" ");
      parts.push({ index, layer: { id: `pdf-path-${page.pageNumber}-${index}`, name: `PDFの図形 ${index + 1}`, type: "shape", shape: "path", x, y, w, h, d,
        fill: fill ? state.fill : "transparent", stroke: stroke ? state.stroke : undefined, strokeWidth: stroke ? state.width * sx : undefined,
        fillRule: evenOps.has(paint) ? "evenodd" : "nonzero", opacity: fill ? state.fillAlpha : state.strokeAlpha } });
    } else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject) {
      try {
        const image = op === OPS.paintInlineImageXObject ? args[0] : await new Promise<any>((resolve, reject) => {
          try { (String(args[0]).startsWith("g_") ? page.commonObjs : page.objs).get(args[0], resolve); } catch (error) { reject(error); }
        });
        if (!image || !image.width || !image.height) throw new Error("画像データがありません");
        const m = Util.transform(viewport.transform, state.matrix);
        // PDFの画像は単位正方形の左上(0,1)から右下(1,0)へ描く。
        const ux = m[0], uy = m[1], vx = -m[2], vy = -m[3], w = Math.hypot(ux, uy), h = Math.hypot(vx, vy);
        if (ux * vy - uy * vx <= 0 || Math.abs(ux * vx + uy * vy) > 1e-5 * w * h) { unsupported("反転・せん断されたPDF画像"); continue; }
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        try {
          const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvasを作れません");
          if (image.bitmap) ctx.drawImage(image.bitmap, 0, 0);
          else {
            const pixels = ctx.createImageData(image.width, image.height), src = image.data;
            if (!src || ![1, 2, 3].includes(image.kind)) throw new Error("未対応の画像形式");
            // 1 ピクセルごとに配列を作らず直接書く（写真 1 枚で数百万ピクセルになる）
            const out = pixels.data, count = image.width * image.height;
            if (image.kind === 3) out.set(src.subarray(0, count * 4));
            else if (image.kind === 2) for (let i = 0, p = 0, q = 0; i < count; i++, p += 4, q += 3) { out[p] = src[q]; out[p + 1] = src[q + 1]; out[p + 2] = src[q + 2]; out[p + 3] = 255; }
            else {
              const stride = Math.ceil(image.width / 8);
              for (let row = 0, p = 0; row < image.height; row++) for (let col = 0; col < image.width; col++, p += 4) {
                const v = src[row * stride + (col >> 3)] & (128 >> (col & 7)) ? 255 : 0;
                out[p] = out[p + 1] = out[p + 2] = v; out[p + 3] = 255;
              }
            }
            ctx.putImageData(pixels, 0, 0);
          }
          const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("画像の保存に失敗")), "image/png"));
          const src = await opts.onImage(blob, "image/png");
          const cx = m[4] + m[2] + (ux + vx) / 2, cy = m[5] + m[3] + (uy + vy) / 2;
          parts.push({ index, layer: { id: `pdf-image-${page.pageNumber}-${index}`, name: `PDFの画像 ${index + 1}`, type: "image", src, fit: "contain",
            x: cx - w / 2, y: cy - h / 2, w, h, rotation: Math.atan2(uy, ux) * 180 / Math.PI, opacity: state.fillAlpha } });
        } finally { canvas.width = canvas.height = 0; }
      } catch { unsupported("PDF画像を個別に取り出せません"); }
    } else if (op === OPS.paintFormXObjectBegin) {
      stack.push({ ...state, matrix: [...state.matrix] });
      if (args[0]) state.matrix = Util.transform(state.matrix, args[0]);
      if (args[1]) unsupported("境界クリップを持つPDFフォーム");
    } else if (op === OPS.paintFormXObjectEnd) {
      const saved = stack.pop(); if (saved) state = saved; else unsupported("PDFフォームの描画状態を復元できません");
    } else if (!ignored.has(op)) unsupported(`未対応のPDF描画命令: ${op}`);
  }
  return { parts, supported: warnings.length === 0, warnings };
}
