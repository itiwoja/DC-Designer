import { isPdf } from "../import/pdfDocument";
import type { AppMode } from "./mode";

/** ドラッグ中のデータにファイルが含まれるか（文字やリンク・レイヤーの並べ替えのドラッグでは反応しない） */
export function hasFiles(dt: Pick<DataTransfer, "types"> | null | undefined): boolean {
  return !!dt && Array.from(dt.types).includes("Files");
}

export const isPptxFile = (f: File) => /\.pptx$/i.test(f.name);

export type HomeDrop = { kind: "pdf" | "pptx"; file: File } | { error: string } | null;

/**
 * ホームへドロップしたファイルから開くものを選ぶ。
 * PDF はどのホームでも開く。.pptx はモード選択画面とスライドのホームで開く。
 * 開けないファイルは理由を返し、何も落とされなければ null
 */
export function pickHomeDrop(files: readonly File[], mode: AppMode | undefined): HomeDrop {
  const pdf = files.find(isPdf);
  if (pdf) return { kind: "pdf", file: pdf };
  const pptx = files.find(isPptxFile);
  if (pptx) return mode === "poster" ? { error: "PowerPoint（.pptx）は「スライド」のホームで開けます" } : { kind: "pptx", file: pptx };
  if (!files.length) return null;
  return { error: mode === "poster" ? "PDF ファイルをドロップしてください" : "PDF か PowerPoint（.pptx）のファイルをドロップしてください" };
}

/** ホームのドロップ先に出す案内 */
export function homeDropLabel(mode: AppMode | undefined): string {
  return mode === "poster" ? "PDF をドロップして開く" : "PDF / PowerPoint をドロップして開く";
}

/**
 * ページのどこにファイルを落としてもブラウザがそのファイルを開いてしまわないようにする。
 * ドロップ先の要素は自分で drop を処理する（ここでは止めるだけ）
 */
export function blockPageFileDrop(target: Pick<Window, "addEventListener" | "removeEventListener"> = window) {
  const guard = (e: DragEvent) => { if (hasFiles(e.dataTransfer)) e.preventDefault(); };
  target.addEventListener("dragover", guard);
  target.addEventListener("drop", guard);
  return () => { target.removeEventListener("dragover", guard); target.removeEventListener("drop", guard); };
}
