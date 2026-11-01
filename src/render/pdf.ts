/**
 * ポスターの PDF 書き出し。
 * 書き出し用の PNG（A4 300dpi）を白地に合成し、可逆圧縮（FlateDecode）の画像 1 枚だけを載せた 1 ページの PDF にする。
 * ページの大きさは画像の画素数と解像度から決めるので、PNG で書き出したときと同じ実寸になる。
 * A4 との差が 0.5mm 以内なら A4 ちょうど（210×297mm）のページにそろえる（300dpi の 2480×3508px は 209.97×297.01mm になるため）。
 * 文字は画像になる（PDF の中で文字として選んだり検索したりはできない）
 */

const PT_PER_INCH = 72;
const MM_PER_INCH = 25.4;
/** A4（mm、縦向き） */
const A4 = { w: 210, h: 297 };

/** 画像の実寸（mm）からページの大きさ（pt）を決める。A4 に十分近ければ A4 ちょうどにする */
export function pageSizePt(wMm: number, hMm: number): { w: number; h: number } {
  const a4 = wMm > hMm ? { w: A4.h, h: A4.w } : A4;
  const near = Math.abs(wMm - a4.w) <= 0.5 && Math.abs(hMm - a4.h) <= 0.5;
  const mm = near ? a4 : { w: wMm, h: hMm };
  return { w: (mm.w / MM_PER_INCH) * PT_PER_INCH, h: (mm.h / MM_PER_INCH) * PT_PER_INCH };
}

/** RGBA の画素を白地に合成して RGB にする（透明な所は白になる。PDF の画像に透明は持たせない） */
export function rgbaToRgbOnWhite(rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const n = rgba.length / 4;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3];
    for (let c = 0; c < 3; c++) {
      const v = rgba[i * 4 + c];
      rgb[i * 3 + c] = a === 255 ? v : Math.round((v * a + 255 * (255 - a)) / 255);
    }
  }
  return rgb;
}

/** zlib 形式（PDF の FlateDecode がそのまま読める形）で圧縮する */
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** PDF の文字列（日本語も入るよう UTF-16BE の 16 進。先頭に BOM） */
function pdfText(s: string): string {
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${hex}>`;
}

/** 小数を PDF に書く形（末尾の 0 を落とす） */
const num = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * RGB の画素（幅 w × 高さ h、1 画素 3 バイト）を、dpi の実寸で 1 ページに敷き詰めた PDF にする
 */
export async function buildImagePdf(rgb: Uint8Array, w: number, h: number, dpi: number, title?: string): Promise<Blob> {
  if (rgb.length !== w * h * 3) throw new Error("画素の数が画像の大きさと合いません");
  const { w: pageW, h: pageH } = pageSizePt((w / dpi) * MM_PER_INCH, (h / dpi) * MM_PER_INCH);
  const image = await deflate(rgb);
  const content = new TextEncoder().encode(`q ${num(pageW)} 0 0 ${num(pageH)} 0 0 cm /Im0 Do Q`);

  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (b: Uint8Array | string) => { const u = typeof b === "string" ? enc.encode(b) : b; parts.push(u); size += u.length; };
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = size;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) { push("stream\n"); push(stream); push("\nendstream\n"); }
    push("endobj\n");
  };

  // バイナリを含むことを示す 2 行目（ビューアーが文字のファイルと見なさないように）
  push(new Uint8Array([...enc.encode("%PDF-1.4\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pageW)} ${num(pageH)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>`, image);
  obj(5, `<< /Length ${content.length} >>`, content);
  obj(6, `<< /Producer (DC-Designer)${title ? ` /Title ${pdfText(title)}` : ""} >>`);

  const xref = size;
  const count = 7;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) table += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as Uint8Array<ArrayBuffer>[], { type: "application/pdf" });
}

/** 書き出し用の PNG を、同じ実寸の 1 ページの PDF にする（ブラウザでだけ動く） */
export async function pngToPdf(png: Blob, dpi: number, title?: string): Promise<Blob> {
  const bitmap = await createImageBitmap(png);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return await buildImagePdf(rgbaToRgbOnWhite(data), bitmap.width, bitmap.height, dpi, title);
  } finally {
    bitmap.close();
  }
}
