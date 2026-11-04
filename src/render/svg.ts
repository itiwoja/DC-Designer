import type { PosterSpec } from "../schema";
import { FALLBACK_FONT, FONT_BY_FAMILY, FONT_CATALOG, matchWeight } from "../fonts";
import { api } from "../editor/api";
import { withOffscreenPoster } from "./offscreen";

/** Google Fonts で提供されているウェイト */
const FONT_WEIGHTS: Record<string, number[]> = Object.fromEntries(FONT_CATALOG.map((f) => [f.family, f.weights]));

const snap = (family: string, w: number) => matchWeight(FONT_WEIGHTS[family] ?? [400], w);

/**
 * 1 回の書き出しの間だけ使う取得結果の入れ物。書き出しごとに作って捨てる（古い画像やフォントを次の書き出しに持ち越さない）。
 * images は画像 URL → data URL、fonts は "family|weight" → @font-face の CSS（失敗は空文字）
 */
export type ExportCache = { images: Map<string, Promise<string>>; fonts: Map<string, Promise<string>> };
export const newExportCache = (): ExportCache => ({ images: new Map(), fonts: new Map() });

export async function toDataUrl(src: string | Blob, cache?: ExportCache): Promise<string> {
  if (typeof src === "string" && src.startsWith("data:")) return src;
  if (cache && typeof src === "string") {
    let hit = cache.images.get(src);
    if (!hit) cache.images.set(src, hit = toDataUrl(src));
    return hit;
  }
  let blob: Blob;
  if (typeof src === "string") {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`画像を読み込めません（HTTP ${response.status}）: ${src}`);
    blob = await response.blob();
    if (blob.type && !blob.type.startsWith("image/")) throw new Error(`画像として読み込めないURLです: ${src}`);
  } else blob = src;
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** /api/fonts/files に一度に頼める face の数 */
const FONT_FILES_CHUNK = 16;

/** 使っている family×weight の TTF を API のフォントキャッシュから取る（作品の文字は送らない）。cache があれば取得済みの face は取り直さない */
export async function buildFontCss(root: Element, cache?: ExportCache): Promise<string> {
  const usage = new Map<string, Set<number>>();
  const add = (fam: string, w: number) => usage.set(fam, (usage.get(fam) ?? new Set()).add(snap(fam, w)));
  root.querySelectorAll("text").forEach((t) => {
    const fam = (t.getAttribute("font-family") ?? "").split(",")[0].replace(/['"]/g, "").trim();
    if (!fam || !FONT_WEIGHTS[fam]) return;
    const w = Number(t.getAttribute("font-weight") ?? 400);
    add(fam, w);
    // かな・英数字だけのフォントに無い文字のフォールバックも埋め込む。
    if (FONT_BY_FAMILY.get(fam)?.script !== "ja") add(FALLBACK_FONT, w);
  });
  const faces = [...usage].flatMap(([family, ws]) => [...ws].sort((a, b) => a - b).map((weight) => ({ family, weight })));
  const fonts = cache?.fonts ?? new Map<string, Promise<string>>();
  const key = (f: { family: string; weight: number }) => `${f.family}|${f.weight}`;
  const todo = faces.filter((f) => !fonts.has(key(f)));
  for (let i = 0; i < todo.length; i += FONT_FILES_CHUNK) {
    const chunk = todo.slice(i, i + FONT_FILES_CHUNK);
    const fetched = (async () => {
      const css = new Map<string, string>();
      try {
        const res = await api.fontFiles(chunk);
        for (const f of res.files) {
          css.set(key(f), `@font-face { font-family: '${f.family}'; font-weight: ${f.weight}; src: url(data:font/ttf;base64,${f.data}) format('truetype'); }`);
        }
        for (const f of res.failed) console.warn("フォント埋め込みに失敗:", f.family, f.weight, f.code);
      } catch (e) {
        console.warn("フォント埋め込みに失敗:", chunk.map((f) => f.family).join(", "), e);
      }
      return css;
    })();
    for (const f of chunk) fonts.set(key(f), fetched.then((m) => m.get(key(f)) ?? ""));
  }
  return (await Promise.all(faces.map((f) => fonts.get(key(f))!))).filter(Boolean).join("\n");
}

/** 画像・フォントを埋め込み、トップレベルに Inkscape/Affinity のレイヤー属性を付けた SVG を作る。 */
export async function buildExportSvg(svg: SVGSVGElement, spec: PosterSpec, opts: { embedFonts?: boolean; cache?: ExportCache } = {}): Promise<string> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  // SVG の名前空間は XMLSerializer が付ける。React が通常属性として置いた xmlns との二重出力を避ける。
  clone.removeAttribute("xmlns");
  clone.removeAttribute("style");
  clone.setAttribute("width", String(spec.meta.width));
  clone.setAttribute("height", String(spec.meta.height));
  clone.setAttribute("xmlns:inkscape", "http://www.inkscape.org/namespaces/inkscape");
  clone.querySelectorAll("[data-export-skip]").forEach((n) => n.remove());
  clone.querySelectorAll("[data-editor-only]").forEach((n) => n.remove());

  // 画面外・プレビュー用の idPrefix に依存せずトップレベルだけを拾う。
  const top = clone.querySelector('[data-poster-layers], g[clip-path="url(#poster-clip)"]');
  top?.querySelectorAll(":scope > g[data-layer-id]").forEach((g) => {
    const name = g.getAttribute("data-layer-name") ?? g.getAttribute("data-layer-id")!;
    g.setAttribute("inkscape:groupmode", "layer");
    g.setAttribute("inkscape:label", name);
    g.setAttribute("id", name.replace(/\s+/g, "_"));
  });

  await Promise.all([...clone.querySelectorAll("image")].map(async (img) => {
    const href = img.getAttribute("href") ?? img.getAttribute("xlink:href");
    if (href) img.setAttribute("href", await toDataUrl(href, opts.cache));
  }));

  if (opts.embedFonts !== false) {
    const css = await buildFontCss(clone, opts.cache);
    if (css) {
      const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
      style.textContent = css;
      clone.insertBefore(style, clone.firstChild);
    }
  }
  return new XMLSerializer().serializeToString(clone);
}

export async function svgToPngBlob(svgText: string, width: number, height: number, scale = 2, crop?: { x: number; y: number; w: number; h: number }): Promise<Blob> {
  const c = crop ?? { x: 0, y: 0, w: width, h: height };
  return rasterize(svgText, width, height, Math.max(1, Math.round(c.w * scale)), Math.max(1, Math.round(c.h * scale)), c);
}

/** ポスター全体を out の画素数ちょうどに描く。 */
export function svgToPngSized(svgText: string, width: number, height: number, out: { w: number; h: number }): Promise<Blob> {
  return rasterize(svgText, width, height, out.w, out.h, { x: 0, y: 0, w: width, h: height });
}

async function rasterize(svgText: string, width: number, height: number, outW: number, outH: number, c: { x: number; y: number; w: number; h: number }): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "sync";
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("SVG のラスタライズに失敗しました"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d")!;
    const sx = outW / c.w, sy = outH / c.h;
    ctx.drawImage(img, -c.x * sx, -c.y * sy, width * sx, height * sy);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG の生成に失敗しました"));
    }, "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function download(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** 参考画像の再現などで、AI に渡すための PNG を作る。 */
export const renderSpecPng = (spec: PosterSpec, scale = 1) =>
  withOffscreenPoster(spec, async (svg) => svgToPngBlob(await buildExportSvg(svg, spec), spec.meta.width, spec.meta.height, scale));
