import PptxGenJS from "pptxgenjs";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Poster } from "./Poster";
import type { Layer, PosterSpec, TextLayerT } from "../schema";
import { resolveColor, resolvePaint, resolveTheme } from "../themes";
import { lineSegments } from "../textRuns";
import { aabb } from "../editor/canvas";
import { cropTarget } from "./ImageBox";
import { FALLBACK_FONT, FONT_BY_FAMILY, FONT_CATALOG } from "../fonts";
import JSZip from "jszip";
import { animationGroups, animationSequence, buildTimingXml, insertTiming, SOUND_REL_RE, soundKey } from "../animation";
import { addSlideSounds, specSounds } from "../sounds";
import { buildTransitionXml } from "../transition";
import { api } from "../editor/api";

/** Google Fonts で提供されているウェイト（書き出し時のサブセット取得用） */
const FONT_WEIGHTS: Record<string, number[]> = Object.fromEntries(FONT_CATALOG.map((f) => [f.family, f.weights]));

const snap = (family: string, w: number) => {
  const list = FONT_WEIGHTS[family] ?? [400];
  return list.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));
};

async function toDataUrl(src: string | Blob): Promise<string> {
  if (typeof src === "string" && src.startsWith("data:")) return src;
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

/** 使われている文字だけを含むフォントサブセットを Google Fonts から取得して @font-face を作る */
async function buildFontCss(root: Element): Promise<string> {
  const usage = new Map<string, { chars: Set<string>; weights: Set<number> }>();
  root.querySelectorAll("text").forEach((t) => {
    const fam = (t.getAttribute("font-family") ?? "").split(",")[0].replace(/['"]/g, "").trim();
    if (!fam || !FONT_WEIGHTS[fam]) return;
    const u = usage.get(fam) ?? { chars: new Set(), weights: new Set() };
    for (const ch of t.textContent ?? "") u.chars.add(ch);
    u.weights.add(snap(fam, Number(t.getAttribute("font-weight") ?? 400)));
    usage.set(fam, u);
    // かな・英数字だけのフォントに無い文字は、フォールバックの Noto Sans JP で表示されるので一緒に埋め込む
    if (FONT_BY_FAMILY.get(fam)?.script !== "ja") {
      const fb = usage.get(FALLBACK_FONT) ?? { chars: new Set(), weights: new Set() };
      for (const ch of t.textContent ?? "") fb.chars.add(ch);
      fb.weights.add(snap(FALLBACK_FONT, Number(t.getAttribute("font-weight") ?? 400)));
      usage.set(FALLBACK_FONT, fb);
    }
  });
  const css: string[] = [];
  for (const [fam, u] of usage) {
    const weights = [...u.weights].sort((a, b) => a - b);
    const famParam = FONT_WEIGHTS[fam].length > 1 ? `${fam}:wght@${weights.join(";")}` : fam;
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(famParam).replace(/%20/g, "+")}&text=${encodeURIComponent([...u.chars].join(""))}`;
    try {
      let text = await (await fetch(url)).text();
      const urls = [...text.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
      for (const fu of urls) text = text.replace(fu, await toDataUrl(fu));
      css.push(text);
    } catch (e) {
      console.warn("フォント埋め込みに失敗:", fam, e);
    }
  }
  return css.join("\n");
}

/**
 * 書き出し用の自己完結 SVG 文字列を作る。
 * - レイヤー（トップレベルの <g>）に Inkscape/Affinity 互換のレイヤー属性を付与
 * - 画像は data URI に、フォントはサブセットを埋め込み
 */
export async function buildExportSvg(svg: SVGSVGElement, spec: PosterSpec, opts: { embedFonts?: boolean } = {}): Promise<string> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.removeAttribute("style");
  clone.setAttribute("width", String(spec.meta.width));
  clone.setAttribute("height", String(spec.meta.height));
  clone.setAttribute("xmlns:inkscape", "http://www.inkscape.org/namespaces/inkscape");
  clone.querySelectorAll("[data-export-skip]").forEach((n) => n.remove());
  clone.querySelectorAll("[data-editor-only]").forEach((n) => n.remove());

  // トップレベルのレイヤーを「レイヤー」として扱えるようにする
  const top = clone.querySelector('g[clip-path="url(#poster-clip)"]');
  top?.querySelectorAll(":scope > g[data-layer-id]").forEach((g) => {
    const name = g.getAttribute("data-layer-name") ?? g.getAttribute("data-layer-id")!;
    g.setAttribute("inkscape:groupmode", "layer");
    g.setAttribute("inkscape:label", name);
    g.setAttribute("id", name.replace(/\s+/g, "_"));
  });

  for (const img of clone.querySelectorAll("image")) {
    const href = img.getAttribute("href") ?? img.getAttribute("xlink:href");
    if (href) img.setAttribute("href", await toDataUrl(href));
  }

  if (opts.embedFonts !== false) {
    const css = await buildFontCss(clone);
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

/** ポスター全体を out の画素数ちょうどに描く（A4 300dpi の 2480×3508 のように、縦横の倍率がわずかに違ってもよい） */
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
    // ポスター全体を拡大して描き、crop 領域だけがキャンバスに入るようずらす
    const sx = outW / c.w, sy = outH / c.h;
    ctx.drawImage(img, -c.x * sx, -c.y * sy, width * sx, height * sy);
    return await new Promise((res) => canvas.toBlob((b) => res(b!), "image/png"));
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

/** レイヤーのポスター座標系でのバウンディングボックス（回転・縁取り・影込み） */
function layerBox(svg: SVGSVGElement, spec: PosterSpec, id: string) {
  const g = svg.querySelector(`[data-layer-id="${CSS.escape(id)}"]`) as SVGGElement | null;
  if (!g) return null;
  const sr = svg.getBoundingClientRect();
  const r = g.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const k = spec.meta.width / sr.width;
  const pad = 12;
  let b = { x: (r.left - sr.left) * k, y: (r.top - sr.top) * k, w: r.width * k, h: r.height * k };
  // 拡大トリミングした画像は、切り抜かれてはみ出した部分まで測られるので枠で抑える
  const l = spec.layers.find((x) => x.id === id);
  const crop = cropTarget(l)?.crop;
  if (l && crop && crop.scale > 1) b = aabb(l);
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  return {
    x, y,
    w: Math.min(spec.meta.width - x, b.w + pad * 2),
    h: Math.min(spec.meta.height - y, b.h + pad * 2),
  };
}

/** 縁取り・斜体・グラデーションのない text レイヤー（PowerPoint のテキストボックスにできる） */
export function isPlainText(l: Layer, theme: ReturnType<typeof resolveTheme>): l is TextLayerT {
  // "$title" のようなテーマトークンも、解決後にグラデーションならテキストボックスにしない
  return l.type === "text" && !l.outlines?.length && !l.skewX && typeof resolvePaint(l.fill, theme) !== "object";
}

/** layer の opacity（0〜1）→ pptxgenjs の transparency（0〜100）。0 でも 100 になる */
export function textTransparency(opacity: number | undefined): number {
  return Math.round((1 - Math.min(1, Math.max(0, opacity ?? 1))) * 100);
}

/**
 * PowerPoint 書き出し。各レイヤーを個別のオブジェクトとして配置する。
 * - 縁取り・グラデーションのない text レイヤー → 編集可能なテキストボックス（フォントは使った文字だけ埋め込む）
 * - それ以外 → レイヤー単位で切り出した透過 PNG
 */
export async function buildPptx(svg: SVGSVGElement, spec: PosterSpec): Promise<Blob> {
  const pptx = newPptx(spec);
  const fonts: FontUsage = new Map();
  const timing = buildTransitionXml(spec.transition) + await addPosterSlide(pptx, svg, spec, fonts);
  return finishPptx((await pptx.write({ outputType: "blob" })) as Blob, [timing], fonts, [spec]);
}

/** テキストボックスで使ったフォント（"ファミリー|太字か" → 使った文字） */
type FontUsage = Map<string, { family: string; bold: boolean; text: string }>;

/**
 * pptxgenjs が書けないものを、書き出した .pptx に後から入れる。
 * - 画面切り替え・アニメーション: timings[i]（<p:transition> と <p:timing>）をスライド i+1 の XML に（空ならそのまま）。効果音は WAV にして ppt/media に入れる
 * - フォント: カタログのフォントを埋め込む。受け取った人の PC に無くても同じフォントで表示され、文字幅が変わって崩れない
 */
async function finishPptx(blob: Blob, timings: string[], fonts: FontUsage, specs: PosterSpec[]): Promise<Blob> {
  const embedded = fonts.size ? await api.embedFonts([...fonts.values()]).then((r) => r.fonts).catch((e) => {
    console.warn("フォントを埋め込めませんでした:", e);
    return [];
  }) : [];
  const latin = [...new Set([...fonts.values()].map((f) => f.family))].filter((f) => FONT_BY_FAMILY.get(f)?.script === "latin");
  if (!timings.some(Boolean) && !embedded.length && !latin.length) return blob;
  const zip = await JSZip.loadAsync(blob);
  for (const [i, timing] of timings.entries()) {
    const path = `ppt/slides/slide${i + 1}.xml`;
    const file = zip.file(path);
    if (!file || (!timing && !latin.length)) continue;
    let xml = await file.async("string");
    if (timing) {
      xml = insertTiming(xml, timing);
      // XML に書いた音の名前 → そのスライドの音（ファイルの音は保存先が要る）
      const sounds = new Map(specSounds(specs[i]).map((s) => [soundKey(s), s]));
      await addSlideSounds(zip, i + 1, [...timing.matchAll(SOUND_REL_RE)].flatMap((m) => sounds.get(m[1]) ?? []));
    }
    // pptxgenjs は latin・ea・cs に同じフォントを書く。英数字だけのフォントだと日本語が PowerPoint 任せになるので ea だけ替える
    for (const f of latin) xml = xml.split(`<a:ea typeface="${f}"`).join(`<a:ea typeface="${FALLBACK_FONT}"`);
    zip.file(path, xml);
  }
  if (embedded.length) await embedFontFiles(zip, embedded);
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
}

/** ppt/fonts/*.fntdata に EOT を置き、presentation.xml の embeddedFontLst から参照する */
export async function embedFontFiles(zip: JSZip, fonts: { family: string; bold: boolean; data: string }[]) {
  const relsPath = "ppt/_rels/presentation.xml.rels";
  let rels = await zip.file(relsPath)!.async("string");
  let pres = await zip.file("ppt/presentation.xml")!.async("string");
  let types = await zip.file("[Content_Types].xml")!.async("string");
  const xmlAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

  const byFamily = new Map<string, { regular?: string; bold?: string }>();
  fonts.forEach((f, i) => {
    const rid = `rIdFont${i + 1}`;
    zip.file(`ppt/fonts/font${i + 1}.fntdata`, f.data, { base64: true });
    rels = rels.replace("</Relationships>", `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font${i + 1}.fntdata"/></Relationships>`);
    byFamily.set(f.family, { ...byFamily.get(f.family), [f.bold ? "bold" : "regular"]: rid });
  });
  const list = [...byFamily].map(([family, r]) =>
    `<p:embeddedFont><p:font typeface="${xmlAttr(family)}" pitchFamily="34" charset="-128"/>${r.regular ? `<p:regular r:id="${r.regular}"/>` : ""}${r.bold ? `<p:bold r:id="${r.bold}"/>` : ""}</p:embeddedFont>`).join("");
  // embeddedFontLst は notesSz の直後（スキーマの順番）
  pres = pres.replace(/(<p:notesSz\b[^>]*\/>)/, `$1<p:embeddedFontLst>${list}</p:embeddedFontLst>`);
  // pptxgenjs は saveSubsetFonts を書いている。同じ属性を重ねると PowerPoint が壊れたファイルとして扱う
  pres = pres.replace(/<p:presentation\b[^>]*>/, (tag) =>
    tag.replace(/\s(embedTrueTypeFonts|saveSubsetFonts)="[^"]*"/g, "").replace(/^<p:presentation\b/, '<p:presentation embedTrueTypeFonts="1" saveSubsetFonts="1"'));
  if (!types.includes('Extension="fntdata"')) types = types.replace("<Default ", '<Default Extension="fntdata" ContentType="application/x-fontdata"/><Default ');

  zip.file(relsPath, rels);
  zip.file("ppt/presentation.xml", pres);
  zip.file("[Content_Types].xml", types);
}

const PX_PER_IN = 100;
function newPptx(spec: PosterSpec) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "POSTER", width: spec.meta.width / PX_PER_IN, height: spec.meta.height / PX_PER_IN });
  pptx.layout = "POSTER";
  return pptx;
}

/**
 * 複数のポスター（PPTX エディターモードのスライド）を 1 つの PowerPoint にまとめる。
 * 各スライドは画面外に描画してから、1 枚の書き出しと同じ方法でオブジェクト化する
 */
export async function buildDeckPptx(specs: PosterSpec[], onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const pptx = newPptx(specs[0]);
  const timings: string[] = [];
  const fonts: FontUsage = new Map();
  for (const [i, spec] of specs.entries()) {
    onProgress?.(i, specs.length);
    timings.push(buildTransitionXml(spec.transition) + await withOffscreenPoster(spec, (svg) => addPosterSlide(pptx, svg, spec, fonts)));
  }
  onProgress?.(specs.length, specs.length);
  return finishPptx((await pptx.write({ outputType: "blob" })) as Blob, timings, fonts, specs);
}

/** spec を画面外に実寸で描画し、その SVG で fn を実行する（エディタに開いていないポスターの書き出し・比較用） */
async function withOffscreenPoster<T>(spec: PosterSpec, fn: (svg: SVGSVGElement) => Promise<T>): Promise<T> {
  const host = document.createElement("div");
  // 実寸で描画しないと getBoundingClientRect による切り抜き範囲がずれる
  host.style.cssText = `position:fixed;left:-100000px;top:0;pointer-events:none;width:${spec.meta.width}px;`;
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    let svg: SVGSVGElement | null = null;
    flushSync(() => root.render(createElement(Poster, { spec, ref: (el: SVGSVGElement | null) => { svg = el; } })));
    // 文字の自動縮小（useLayoutEffect）とフォント読み込みを待つ
    await document.fonts?.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!svg) throw new Error("ポスターを描画できませんでした");
    return await fn(svg);
  } finally {
    root.unmount();
    host.remove();
  }
}

/** spec を PNG に描画する（参考画像の再現で、AI に今の見た目を見せる） */
export const renderSpecPng = (spec: PosterSpec, scale = 1) =>
  withOffscreenPoster(spec, async (svg) => svgToPngBlob(await buildExportSvg(svg, spec), spec.meta.width, spec.meta.height, scale));

/** スライドを 1 枚足し、そのスライドのアニメーション（<p:timing>。無ければ空文字）を返す。使ったフォントは fonts に足す */
async function addPosterSlide(pptx: PptxGenJS, svg: SVGSVGElement, spec: PosterSpec, fonts: FontUsage): Promise<string> {
  const theme = resolveTheme(spec.theme, spec.themeOverride);
  const { width, height } = spec.meta;
  const slide = pptx.addSlide();
  // 台本は PowerPoint のノートにする（発表者ツールで見られる）
  if (spec.notes?.trim()) slide.addNotes(spec.notes);
  const full = await buildExportSvg(svg, spec);
  const doc = new DOMParser().parseFromString(full, "image/svg+xml");
  const inch = (v: number) => v / PX_PER_IN;
  const visible = spec.layers.filter((l) => l.visible !== false && (!l.themes || l.themes.includes(spec.theme)));

  // 画像化が必要なレイヤーは並列でラスタライズしておく
  const rasters = await Promise.all(visible.map(async (l) => {
    if (isPlainText(l, theme)) return null;
    const box = l.type === "background" ? { x: 0, y: 0, w: width, h: height } : layerBox(svg, spec, l.id);
    if (!box) return null;
    // 対象レイヤー以外を消した SVG を作り、viewBox で box だけを描画する
    const d = doc.cloneNode(true) as Document;
    d.querySelectorAll("[data-layer-id]").forEach((g) => {
      if (g.parentElement?.closest("[data-layer-id]")) return; // ネストは親に従う
      if (g.getAttribute("data-layer-id") !== l.id) g.remove();
    });
    const root = d.documentElement;
    root.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);
    root.setAttribute("width", String(box.w));
    root.setAttribute("height", String(box.h));
    // 文字を含まないレイヤーはフォント埋め込みを外して軽くする
    if (!root.querySelector("text")) root.querySelectorAll(":scope > style").forEach((st) => st.remove());
    const png = await svgToPngBlob(new XMLSerializer().serializeToString(d), box.w, box.h, 2);
    return { box, data: await toDataUrl(png) };
  }));

  // pptxgenjs は図形に「追加した順番 + 2」の id を振る。アニメーションの対象指定に使う
  const spids = new Map<string, number>();
  const textIds = new Set<string>();
  let added = 0;
  // 重なり順を保つため、配置は spec の順番どおりに行う
  visible.forEach((l, i) => {
    if (isPlainText(l, theme)) {
      const fill = resolvePaint(l.fill, theme);
      const hex = (c: string) => c.replace("#", "").slice(0, 6);
      const color = hex(typeof fill === "string" ? fill : "#000000");
      const face = theme.fonts[l.font] ?? l.font;
      // 太字を持たないフォント（極太の 1 ウェイトのみなど）に太字を付けると PowerPoint が擬似太字にしてつぶれる
      const hasBold = !FONT_WEIGHTS[face] || FONT_WEIGHTS[face].some((w) => w >= 600);
      const bold = hasBold && (l.weight ?? 700) >= 600;
      const addUsage = (family: string) => {
        const key = `${family}|${bold}`;
        fonts.set(key, { family, bold, text: (fonts.get(key)?.text ?? "") + l.text });
      };
      if (FONT_WEIGHTS[face]) addUsage(face);
      // 英数字だけのフォントは、日本語の文字（東アジアのフォント）を Noto Sans JP にする（finishPptx で差し替える）
      if (FONT_BY_FAMILY.get(face)?.script === "latin") addUsage(FALLBACK_FONT);
      // 枠に収めるため縮小した文字（fit: "shrink"）は、縮小後の大きさで書く
      const scale = Number(svg.querySelector(`[data-layer-id="${CSS.escape(l.id)}"] [data-text-block]`)?.getAttribute("data-fit-scale")) || 1;
      const pt = l.size * 0.72 * scale;
      // 部分色は行ごと・色の切れ目ごとの断片にして渡す
      const transparency = textTransparency(l.opacity);
      const content = l.colorRuns?.length
        ? lineSegments(l.text, l.colorRuns).flatMap((segs, i, all) => {
          const parts = segs.length ? segs : [{ text: "" }];
          return parts.map((s, j) => ({
            text: s.text,
            options: {
              ...(s.color ? { color: hex(resolveColor(s.color, theme)) } : {}),
              transparency,
              ...(j === parts.length - 1 && i < all.length - 1 ? { breakLine: true } : {}),
            },
          }));
        })
        : l.text;
      slide.addText(content, {
        x: inch(l.x), y: inch(l.y), w: inch(l.w), h: inch(l.h),
        fontFace: face, fontSize: pt, bold,
        color, transparency, align: l.align, valign: "top", margin: 0, rotate: l.rotation ?? 0,
        // エディタは改行の位置でしか折り返さないので、PowerPoint でも折り返さない（文字幅の違いで行が増えて崩れるのを防ぐ）
        wrap: false,
        // 行の高さは倍数だとフォントごとの行の高さに掛かってずれるので、エディタと同じ「文字サイズ × 行間」の固定値にする
        lineSpacing: pt * (l.lineHeight ?? 1.25),
        charSpacing: l.letterSpacing ? l.letterSpacing * pt : undefined,
      });
      spids.set(l.id, added++ + 2);
      textIds.add(l.id);
      return;
    }
    const r = rasters[i];
    if (!r) return;
    slide.addImage({ data: r.data, x: inch(r.box.x), y: inch(r.box.y), w: inch(r.box.w), h: inch(r.box.h), altText: l.name ?? l.id });
    spids.set(l.id, added++ + 2);
  });
  return buildTimingXml(animationGroups(animationSequence(spec)), spids, textIds);
}
