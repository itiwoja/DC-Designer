import type PptxGenJS from "pptxgenjs";
import { withOffscreenPoster } from "./offscreen";
import { buildExportSvg, newExportCache, svgToPngBlob, toDataUrl, type ExportCache } from "./svg";
import type { Layer, PosterSpec, TextLayerT } from "../schema";
import { resolveColor, resolvePaint, resolveTheme } from "../themes";
import { lineSegments } from "../textRuns";
import { aabb } from "../editor/canvas";
import { cropTarget } from "./ImageBox";
import { FALLBACK_FONT, FONT_BY_FAMILY, FONT_CATALOG } from "../fonts";
import JSZip from "jszip";
import { animationGroups, animationSequence, buildTimingXml, insertTiming, planScroll, SOUND_REL_RE, soundKey, type ScrollMove } from "../animation";
import { loadImageRatio } from "./imageRatio";
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
  const timing = buildTransitionXml(spec.transition) + placePosterSlide(pptx, spec, await prepareSlide(svg, spec, newExportCache()), fonts);
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
  const fonts: FontUsage = new Map();
  const cache = newExportCache(); // 同じロゴ・背景・フォントをスライドごとに取り直さない（この書き出しの間だけ）
  const prepared: (PreparedSlide | undefined)[] = new Array(specs.length);
  let next = 0, done = 0, failed = false;
  onProgress?.(0, specs.length);
  // 描画と画像化は同時に数枚ずつ進める。スライドへの配置は下で順番どおりに行う
  const worker = async () => {
    while (!failed && next < specs.length) {
      const i = next++;
      try {
        prepared[i] = await withOffscreenPoster(specs[i], (svg) => prepareSlide(svg, specs[i], cache));
      } catch (e) { failed = true; throw e; }
      onProgress?.(++done, specs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DECK_CONCURRENCY, specs.length) }, worker));
  const timings = specs.map((spec, i) => buildTransitionXml(spec.transition) + placePosterSlide(pptx, spec, prepared[i]!, fonts));
  return finishPptx((await pptx.write({ outputType: "blob" })) as Blob, timings, fonts, specs);
}

/** デッキ書き出しで同時に描画・画像化するスライドの数 */
const DECK_CONCURRENCY = 3;

/** 画面外の SVG から先に取り出しておくもの（配置は SVG が無くてもできる） */
type PreparedSlide = {
  rasters: ({ box: { x: number; y: number; w: number; h: number }; data: string } | null)[];
  /** text レイヤー id → 縮小倍率（fit: "shrink"） */
  fitScales: Map<string, number>;
};

/** visible（表示するレイヤー）の画像化と、文字の縮小倍率の読み取り。ここまでは SVG が要るので並列にできる */
async function prepareSlide(svg: SVGSVGElement, spec: PosterSpec, cache: ExportCache): Promise<PreparedSlide> {
  const theme = resolveTheme(spec.theme, spec.themeOverride);
  const { width, height } = spec.meta;
  const visible = spec.layers.filter((l) => l.visible !== false && (!l.themes || l.themes.includes(spec.theme)));
  const fitScales = new Map<string, number>();
  for (const l of visible) {
    if (isPlainText(l, theme)) fitScales.set(l.id, Number(svg.querySelector(`[data-layer-id="${CSS.escape(l.id)}"] [data-text-block]`)?.getAttribute("data-fit-scale")) || 1);
  }
  // 全レイヤーがテキストボックスになるスライドは、画像化に使う SVG（画像・フォントの埋め込み）を作らない
  if (visible.every((l) => isPlainText(l, theme))) return { rasters: visible.map(() => null), fitScales };
  const full = await buildExportSvg(svg, spec, { cache });
  const doc = new DOMParser().parseFromString(full, "image/svg+xml");

  /** doc から keep に当てはまるトップレベルのレイヤーだけ残し、viewBox の範囲を画像にする */
  const rasterize = async (box: { x: number; y: number; w: number; h: number }, keep: (id: string) => boolean, edit?: (d: Document) => void, scale = 2) => {
    const d = doc.cloneNode(true) as Document;
    d.querySelectorAll("[data-layer-id]").forEach((g) => {
      if (g.parentElement?.closest("[data-layer-id]")) return; // ネストは親に従う
      if (!keep(g.getAttribute("data-layer-id") ?? "")) g.remove();
    });
    edit?.(d);
    const root = d.documentElement;
    root.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);
    root.setAttribute("width", String(box.w));
    root.setAttribute("height", String(box.h));
    // 文字を含まないレイヤーはフォント埋め込みを外して軽くする
    if (!root.querySelector("text")) root.querySelectorAll(":scope > style").forEach((st) => st.remove());
    const png = await svgToPngBlob(new XMLSerializer().serializeToString(d), box.w, box.h, scale);
    return { box, data: await toDataUrl(png) };
  };

  // スクロール: 画像全体を 1 枚で置き、はみ出す部分は「このレイヤーより下のもの」の帯で隠す
  const scrollPlans = new Map<string, NonNullable<ReturnType<typeof planScroll>>>();
  await Promise.all(visible.map(async (l) => {
    if (l.type !== "image" || !l.src || l.animation?.effect !== "scroll") return;
    const ratio = (await loadImageRatio(l.src)) ?? l.crop?.ratio;
    const plan = ratio ? planScroll(l, ratio, l.animation, spec.meta) : null;
    if (plan) scrollPlans.set(l.id, plan);
  }));
  const scrollRasters = new Map<string, { picture: Awaited<ReturnType<typeof rasterize>>; bands: Awaited<ReturnType<typeof rasterize>>[] }>();
  await Promise.all([...scrollPlans].map(async ([id, plan]) => {
    const under = new Set(spec.layers.slice(0, spec.layers.findIndex((x) => x.id === id)).map((x) => x.id));
    const { picture } = plan;
    const picture1 = await rasterize(picture, (lid) => lid === id, (d) => {
      const img = d.querySelector(`[data-layer-id="${CSS.escape(id)}"] [data-scroll-image]`);
      if (!img) return;
      // 枠の clip と影を外し、画像全体の大きさで描く
      // 位置はレイヤーの枠からの相対（流し始めの端に置く）
      const l = spec.layers.find((x) => x.id === id)!;
      img.setAttribute("x", String(picture.x - l.x));
      img.setAttribute("y", String(picture.y - l.y));
      img.setAttribute("width", String(picture.w));
      img.setAttribute("height", String(picture.h));
      img.setAttribute("preserveAspectRatio", "none");
      img.parentElement?.removeAttribute("clip-path");
      img.closest("[data-layer-id]")?.removeAttribute("filter");
    }, Math.min(2, 8192 / Math.max(picture.w, picture.h)));
    const bands = await Promise.all(plan.bands.map((b) => rasterize(b, (lid) => under.has(lid))));
    scrollRasters.set(id, { picture: picture1, bands });
  }));

  // 画像化が必要なレイヤーは並列でラスタライズしておく
  const rasters = await Promise.all(visible.map(async (l) => {
    if (isPlainText(l, theme) || scrollPlans.has(l.id)) return null;
    const box = l.type === "background" ? { x: 0, y: 0, w: width, h: height } : layerBox(svg, spec, l.id);
    if (!box) return null;
    // 対象レイヤー以外を消した SVG を作り、viewBox で box だけを描画する
    return rasterize(box, (id) => id === l.id);
  }));

  return { rasters, fitScales };
}

/** スライドを 1 枚足し、そのスライドのアニメーション（<p:timing>。無ければ空文字）を返す。使ったフォントは fonts に足す。呼んだ順がスライドの順 */
function placePosterSlide(pptx: PptxGenJS, spec: PosterSpec, { rasters, fitScales }: PreparedSlide, fonts: FontUsage): string {
  const theme = resolveTheme(spec.theme, spec.themeOverride);
  const slide = pptx.addSlide();
  // 台本は PowerPoint のノートにする（発表者ツールで見られる）
  if (spec.notes?.trim()) slide.addNotes(spec.notes);
  const inch = (v: number) => v / PX_PER_IN;
  const visible = spec.layers.filter((l) => l.visible !== false && (!l.themes || l.themes.includes(spec.theme)));

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
      const scale = fitScales.get(l.id) ?? 1;
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
        fontFace: face, fontSize: pt, bold, ...(l.underline ? { underline: { style: "sng" as const } } : {}),
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
    const sc = scrollRasters.get(l.id);
    if (sc) {
      // 画像全体 → すぐ上に帯（帯は動かさない）の順に置く
      for (const [k, r] of [sc.picture, ...sc.bands].entries()) {
        slide.addImage({ data: r.data, x: inch(r.box.x), y: inch(r.box.y), w: inch(r.box.w), h: inch(r.box.h), altText: k ? `${l.name ?? l.id}（スクロールの帯）` : l.name ?? l.id });
        if (!k) spids.set(l.id, added + 2);
        added++;
      }
      return;
    }
    const r = rasters[i];
    if (!r) return;
    slide.addImage({ data: r.data, x: inch(r.box.x), y: inch(r.box.y), w: inch(r.box.w), h: inch(r.box.h), altText: l.name ?? l.id });
    spids.set(l.id, added++ + 2);
  });
  // 流せなかったスクロール（回転・はみ出しなし・画像が読めない）は、フェードで代わりにする
  const timed: PosterSpec = {
    ...spec,
    layers: spec.layers.map((l) => (l.animation?.effect === "scroll" && !scrollPlans.has(l.id) ? { ...l, animation: { ...l.animation, effect: "fade" as const, direction: undefined, scrollTo: undefined } } : l)),
  };
  const moves = new Map<string, ScrollMove>([...scrollPlans].map(([id, p]) => [id, p.move]));
  return buildTimingXml(animationGroups(animationSequence(timed)), spids, textIds, moves);
}
