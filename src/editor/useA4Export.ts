import { useState, type RefObject } from "react";
import type { PosterSpec } from "../schema";
import { pngToPdf } from "../render/pdf";
import { buildExportSvg, download, svgToPngSized } from "../render/svg";
import { a4Fit, a4Size, exportPixels, pngA4Report, PRINT_DPI, readPngInfo, setPngDpi } from "./a4";
import { safeFileName } from "./specOps";
import type { Notice } from "./Toasts";

type SetSpec = (next: PosterSpec | ((prev: PosterSpec) => PosterSpec), coalesceKey?: string) => void;

/** ポスターの A4 での書き出し（PNG・PDF・印刷プレビュー）と、用紙を A4 にそろえる操作 */
export function useA4Export({ spec, setSpec, svgRef, run, notify, exported, notifyRestorable }: {
  spec: PosterSpec;
  setSpec: SetSpec;
  svgRef: RefObject<SVGSVGElement | null>;
  run: (label: string, fn: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  notify: (n: Omit<Notice, "id">) => void;
  exported: (name: string) => void;
  notifyRestorable: (text: string, before: PosterSpec, kind: "info") => void;
}) {
  const W = spec.meta.width, H = spec.meta.height;
  const [a4Guide, setA4Guide] = useState(false);
  /** A4 300dpi ちょうど（2480×3508px）に描き、解像度（pHYs）を書き込んだ PNG */
  const buildA4Png = async () => {
    const blob = await svgToPngSized(await buildExportSvg(svgRef.current!, spec), W, H, exportPixels(W, H));
    return new Blob([setPngDpi(new Uint8Array(await blob.arrayBuffer()), PRINT_DPI) as Uint8Array<ArrayBuffer>], { type: "image/png" });
  };
  /** 書き出した PNG を読み直し、画素数と解像度から実寸が A4 になっているかを知らせる（size は知らせる大きさの書き方） */
  const reportA4 = async (name: string, png: Blob, size: (info: { w: number; h: number }, r: NonNullable<ReturnType<typeof pngA4Report>>) => string) => {
    const info = readPngInfo(new Uint8Array(await png.arrayBuffer()));
    const r = info && pngA4Report(info);
    if (!info || !r) return exported(name);
    const s = size(info, r);
    notify(r.ok
      ? { kind: "success", text: `${name} を A4 で書き出しました（${s}）` }
      : { kind: "error", text: `${name} を書き出しましたが、A4 の大きさではありません（${s}）。A4 チェックからそろえられます` });
  };
  const exportPng = () => run("PNG を書き出し中", async () => {
    const name = `${safeFileName(spec.meta.title)}.png`;
    const blob = await buildA4Png();
    download(blob, name);
    await reportA4(name, blob, (info, r) => `${info.w}×${info.h}px・${r.dpi ?? "?"}dpi → ${r.wMm.toFixed(1)}×${r.hMm.toFixed(1)}mm`);
  });
  /** PNG と同じ A4 300dpi の画像を、同じ実寸の 1 ページの PDF にする（印刷所・提出用） */
  const exportPdf = () => run("PDF を書き出し中", async () => {
    const name = `${safeFileName(spec.meta.title)}.pdf`;
    const png = await buildA4Png();
    download(await pngToPdf(png, PRINT_DPI, spec.meta.title || undefined), name);
    await reportA4(name, png, (_, r) => `${r.wMm.toFixed(1)}×${r.hMm.toFixed(1)}mm`);
  });
  /** A4 の大きさで印刷プレビューを開く（ブラウザの印刷画面で用紙 A4・余白なしで確かめられる） */
  const printA4 = () => {
    // ポップアップを止められないよう、クリックのうちに窓だけ開いておく
    const w = window.open("", "_blank");
    if (!w) return notify({ kind: "error", text: "印刷プレビューの窓を開けませんでした（ポップアップを許可してください）" });
    const fit = a4Fit(W, H);
    w.document.title = `${spec.meta.title || "無題のポスター"} - A4 印刷プレビュー`;
    w.document.body.textContent = "印刷用の画像を作っています…";
    run("印刷プレビューを準備中", async () => {
      const url = URL.createObjectURL(await buildA4Png());
      const { page } = fit;
      w.document.head.innerHTML = `<style>
        @page { size: A4 ${fit.orientation}; margin: 0; }
        html, body { margin: 0; background: #888; }
        img { display: block; width: ${page.w}mm; height: ${page.h}mm; margin: 0 auto; background: #fff; }
        @media screen { img { margin: 16px auto; box-shadow: 0 2px 12px rgba(0,0,0,.4); } }
        @media print { html, body { background: none; } }
      </style>`;
      w.document.body.innerHTML = "";
      const img = w.document.createElement("img");
      img.alt = spec.meta.title;
      img.onload = () => { w.focus(); w.print(); };
      img.src = url;
      w.document.body.append(img);
      w.addEventListener("beforeunload", () => URL.revokeObjectURL(url));
    });
  };
  const fixA4 = () => {
    const before = spec;
    setSpec((s) => ({ ...s, meta: { ...s.meta, ...a4Size(s.meta.width, s.meta.height) } }));
    notifyRestorable("用紙を A4 の大きさにそろえました", before, "info");
  };
  return { a4Guide, setA4Guide, exportPng, exportPdf, printA4, fixA4 };
}
