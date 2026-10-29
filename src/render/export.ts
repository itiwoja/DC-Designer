import type PptxGenJS from "pptxgenjs";
import { withOffscreenPoster } from "./offscreen";
import { buildExportSvg, svgToPngBlob, toDataUrl } from "./svg";
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

// 既存の呼び出し元向けの公開 API。SVG/PNG だけを使う画面は ./svg を直接参照する。
export { buildExportSvg, buildFontCss, download, renderSpecPng, svgToPngBlob, svgToPngSized } from "./svg";

/** Google Fonts で提供されているウェイト（太字・フォント埋め込みの判定用） */
const FONT_WEIGHTS: Record<string, number[]> = Object.fromEntries(FONT_CATALOG.map((f) => [f.family, f.weights]));

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
  const pptx = await newPptx(spec);
  const fonts: FontUsage = new Map();
  const timing = buildTransitionXml(spec.transition) + await addPosterSlide(pptx, svg, spec, fonts);
  return finishPptx((await pptx.write({ outputType: "blob" })) as Blob, [timing], fonts, [spec]);
}

/** テキストボックスで使ったフォント（"ファミリー|太字か"） */
type FontUsage = Map<string, { family: string; bold: boolean }>;

/**
 * pptxgenjs が書けないものを、書き出した .pptx に後から入れる。
 * - 画面切り替え・アニメーション: timings[i]（<p:transition> と <p:timing>）をスライド i+1 の XML に（空ならそのまま）。効果音は WAV にして ppt/media に入れる
 * - フォント: カタログのフォントを埋め込む。受け取った人の PC に無くても同じフォントで表示され、文字幅が変わって崩れない
 */
async function finishPptx(blob: Blob, timings: string[], fonts: FontUsage, specs: PosterSpec[]): Promise<Blob> {
  const embedded = fonts.size ? await api.embedFonts([...fonts.values()].map(({ family, bold }) => ({ family, bold }))).then((r) => r.fonts).catch((e) => {
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
async function newPptx(spec: PosterSpec) {
  const { default: PptxGenJS } = await import("pptxgenjs");
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
  const pptx = await newPptx(specs[0]);
  const timings: string[] = [];
  const fonts: FontUsage = new Map();
  for (const [i, spec] of specs.entries()) {
    onProgress?.(i, specs.length);
    timings.push(buildTransitionXml(spec.transition) + await withOffscreenPoster(spec, (svg) => addPosterSlide(pptx, svg, spec, fonts)));
  }
  onProgress?.(specs.length, specs.length);
  return finishPptx((await pptx.write({ outputType: "blob" })) as Blob, timings, fonts, specs);
}

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
        fonts.set(key, { family, bold });
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
