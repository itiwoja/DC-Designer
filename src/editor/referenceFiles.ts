import { MAX_REFERENCE_FILE_BYTES, MAX_REFERENCES } from "../referenceLimits";
import { readDataUrl, type RefImage } from "./api";
import { IMAGE_FILE_ACCEPT, IMAGE_FILE_TYPES } from "./specOps";
import { isPdf, readPdf } from "../import/pdfDocument";
export { isPdf } from "../import/pdfDocument";

export const REFERENCE_FILE_ACCEPT = `${IMAGE_FILE_ACCEPT},application/pdf,.pdf`;
export type ReferencePage = { name: string; img: RefImage; url: string };

/** PDF はページ順に画像化し、既存の画像入力と同じ経路で AI に渡す。 */
export async function readReferenceFile(file: File, remaining = MAX_REFERENCES): Promise<ReferencePage[]> {
  if (remaining < 1) throw new Error(`参考資料は画像・PDFのページを合わせて ${MAX_REFERENCES} 枚までです`);
  if (file.size > MAX_REFERENCE_FILE_BYTES) throw new Error(`${file.name}: 1ファイルは20MBまでです`);
  if (!isPdf(file)) {
    if (!IMAGE_FILE_TYPES.test(file.type)) throw new Error("PNG / JPEG / WebP / GIF / PDF を選んでください");
    const url = await readDataUrl(file);
    return [{ name: file.name, url, img: { mediaType: file.type as RefImage["mediaType"], data: url.split(",")[1] } }];
  }

  return readPdf(file, async (pdf) => {
    if (pdf.numPages > remaining) throw new Error(`${file.name}: ${pdf.numPages} ページあります。追加できるのは残り ${remaining} ページです（合計 ${MAX_REFERENCES} 枚まで）`);
    const pages: ReferencePage[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const size = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(size.width, size.height)) });
      const canvas = document.createElement("canvas");
      try {
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport, background: "rgb(255,255,255)" }).promise;
        const url = canvas.toDataURL("image/jpeg", 0.9);
        if (!url.startsWith("data:image/jpeg;base64,")) throw new Error("PDFのページを画像に変換できませんでした");
        pages.push({ name: `${file.name} (${n}/${pdf.numPages})`, url, img: { mediaType: "image/jpeg", data: url.split(",")[1] } });
      } finally {
        page.cleanup();
        canvas.width = canvas.height = 0;
      }
    }
    return pages;
  });
}
