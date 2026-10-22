import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { MAX_REFERENCE_FILE_BYTES } from "../referenceLimits";

export const PDF_FILE_ACCEPT = "application/pdf,.pdf";
export const isPdf = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

/** 添付と編集用読み込みで、worker・フォント・エラー処理を共用する。 */
export async function readPdf<T>(file: File, read: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
  if (!isPdf(file)) throw new Error("PDFファイルを選んでください");
  if (file.size > MAX_REFERENCE_FILE_BYTES) throw new Error(`${file.name}: 1ファイルは20MBまでです`);
  const { getDocument, GlobalWorkerOptions, PasswordException, InvalidPDFException } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { default: workerUrl } = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
  GlobalWorkerOptions.workerSrc = workerUrl;
  const loading = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: "/api/pdf-assets/cmaps/", cMapPacked: true,
    standardFontDataUrl: "/api/pdf-assets/standard_fonts/", wasmUrl: "/api/pdf-assets/wasm/",
  });
  try {
    return await read(await loading.promise);
  } catch (e) {
    if (e instanceof PasswordException) throw new Error(`${file.name}: パスワードを解除したPDFを添付してください`);
    if (e instanceof InvalidPDFException) throw new Error(`${file.name}: PDFを読み込めません。ファイルが壊れていないか確認してください`);
    throw e;
  } finally {
    await loading.destroy();
  }
}
