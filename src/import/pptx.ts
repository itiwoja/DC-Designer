import JSZip from "jszip";
import { readTransition } from "../transition";
import type { ImageCrop, Layer, Paint, PosterSpec } from "../schema";
import { clampCrop } from "../render/ImageBox";

/**
 * PowerPoint（.pptx）を読み込んで、スライドごとの PosterSpec に変換する。
 * - 座標は書き出し（buildPptx）と同じ 1 inch = 100px。フォントサイズは pt / 0.72 = px
 * - グループは展開してトップレベルのレイヤーにする（エディタで個別に動かせるように）
 * - テキストは段落の書式ごとにテキストレイヤーへ分け、枠の幅で折り返し位置を決めて改行を入れる
 * - 画像は onImage でアップロードし、/generated/... のパスを受け取る
 * - グラフ・SmartArt・EMF/WMF 画像などは読み込めないので warnings に数える
 */

export type PptxImportResult = { name: string; width: number; height: number; slides: PosterSpec[]; warnings: string[] };
export type PptxImportOptions = {
  /** 画像ファイルを保存して src を返す。null なら取り込まない */
  onImage: (blob: Blob, mediaType: string) => Promise<string | null>;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
};

const EMU_PER_PX = 914400 / 100;
const px = (emu: string | null | undefined) => Math.round((Number(emu ?? 0) / EMU_PER_PX) * 100) / 100;
const round = (v: number) => Math.round(v * 10) / 10;

// ---------- XML ヘルパー（名前空間の接頭辞は無視して localName で辿る） ----------
type El = Element;
const kids = (el: El | null | undefined, name?: string): El[] =>
  el ? Array.from(el.children).filter((c) => !name || c.localName === name) : [];
const kid = (el: El | null | undefined, name: string): El | null => kids(el, name)[0] ?? null;
/** "spPr/xfrm/off" のように子要素を辿る */
const at = (el: El | null | undefined, path: string): El | null => {
  let cur: El | null = el ?? null;
  for (const p of path.split("/")) { if (!cur) return null; cur = kid(cur, p); }
  return cur;
};
const attr = (el: El | null | undefined, name: string) => el?.getAttribute(name) ?? null;
/** r:embed / r:id など relationships 名前空間の属性 */
const rattr = (el: El | null | undefined, name: string) => {
  if (!el) return null;
  for (const a of Array.from(el.attributes)) if (a.localName === name && a.prefix && a.prefix !== "") return a.value;
  return null;
};

function dirOf(path: string) { return path.slice(0, path.lastIndexOf("/") + 1); }
function resolvePath(base: string, target: string) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (dirOf(base) + target).split("/");
  const out: string[] = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p !== ".") out.push(p); }
  return out.join("/");
}
const relsPathOf = (path: string) => `${dirOf(path)}_rels/${path.slice(path.lastIndexOf("/") + 1)}.rels`;

// ---------- 色 ----------
const PRESET: Record<string, string> = {
  black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080",
  darkGray: "A9A9A9", lightGray: "D3D3D3", orange: "FFA500", purple: "800080", navy: "000080", silver: "C0C0C0", cyan: "00FFFF", magenta: "FF00FF",
};

function rgbToHsl(r: number, g: number, b: number) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h: number, s: number, l: number) {
  if (!s) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");

type Ctx = {
  zip: JSZip;
  theme: { colors: Record<string, string>; major: { latin?: string; ea?: string }; minor: { latin?: string; ea?: string } };
  clrMap: Record<string, string>;
  defaultTextStyle: El | null;
  opts: PptxImportOptions;
  images: Map<string, Promise<string | null>>;
  warn: (msg: string) => void;
  seq: number;
};

/** a:srgbClr / a:schemeClr などの色要素を CSS カラーへ。phClr は shape style の色で置き換える */
function colorOf(el: El | null, ctx: Ctx, phClr?: string): string | undefined {
  if (!el) return undefined;
  let base: string | undefined;
  switch (el.localName) {
    case "srgbClr": base = attr(el, "val") ?? undefined; break;
    case "sysClr": base = attr(el, "lastClr") ?? (attr(el, "val") === "window" ? "FFFFFF" : "000000"); break;
    case "prstClr": base = PRESET[attr(el, "val") ?? ""] ?? "000000"; break;
    case "scrgbClr": base = ["r", "g", "b"].map((k) => hex2(Number(attr(el, k)) / 100000)).join(""); break;
    case "schemeClr": {
      const v = attr(el, "val") ?? "";
      if (v === "phClr") { base = phClr?.replace("#", "").slice(0, 6); break; }
      base = ctx.theme.colors[ctx.clrMap[v] ?? v];
      break;
    }
    default: return undefined;
  }
  if (!base) return undefined;
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(base!.slice(i, i + 2), 16) / 255);
  let alpha = 1;
  for (const m of kids(el)) {
    const v = Number(attr(m, "val")) / 100000;
    if (m.localName === "alpha") alpha = v;
    else if (m.localName === "lumMod" || m.localName === "lumOff") {
      const [h, s, l] = rgbToHsl(r, g, b);
      [r, g, b] = hslToRgb(h, s, Math.max(0, Math.min(1, m.localName === "lumMod" ? l * v : l + v)));
    } else if (m.localName === "tint") [r, g, b] = [r, g, b].map((c) => c + (1 - c) * (1 - v));
    else if (m.localName === "shade") [r, g, b] = [r, g, b].map((c) => c * v);
  }
  const hex = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return alpha < 1 ? `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${+alpha.toFixed(3)})` : hex;
}
const firstColor = (el: El | null, ctx: Ctx, phClr?: string) => colorOf(kids(el)[0] ?? null, ctx, phClr);

/** spPr / bgPr 直下の塗り。undefined = 指定なし、null = 塗りなし */
function fillOf(parent: El | null, ctx: Ctx, phClr?: string): Paint | null | undefined {
  for (const c of kids(parent)) {
    if (c.localName === "noFill") return null;
    if (c.localName === "solidFill") return firstColor(c, ctx, phClr) ?? null;
    if (c.localName === "gradFill") {
      const stops = kids(at(c, "gsLst"), "gs")
        .map((gs) => ({ offset: Math.max(0, Math.min(1, Number(attr(gs, "pos")) / 100000)), color: firstColor(gs, ctx, phClr) ?? "#000000" }))
        .sort((a, b) => a.offset - b.offset);
      if (stops.length < 2) return stops[0]?.color ?? null;
      if (kid(c, "path")) return { type: "radial", cx: 0.5, cy: 0.5, r: 0.7, stops };
      return { type: "linear", angle: Number(attr(kid(c, "lin"), "ang") ?? 5400000) / 60000, stops };
    }
    if (c.localName === "pattFill") return firstColor(kid(c, "fgClr"), ctx, phClr) ?? null;
  }
  return undefined;
}

// ---------- テーマ・マスター ----------
async function readXml(zip: JSZip, path: string): Promise<Document | null> {
  const f = zip.file(path);
  if (!f) return null;
  return new DOMParser().parseFromString(await f.async("string"), "application/xml");
}
async function readRels(zip: JSZip, path: string): Promise<Map<string, { type: string; target: string }>> {
  const doc = await readXml(zip, relsPathOf(path));
  const out = new Map<string, { type: string; target: string }>();
  for (const r of Array.from(doc?.documentElement.children ?? [])) {
    const mode = r.getAttribute("TargetMode");
    out.set(r.getAttribute("Id")!, { type: (r.getAttribute("Type") ?? "").split("/").pop()!, target: mode === "External" ? "" : resolvePath(path, r.getAttribute("Target") ?? "") });
  }
  return out;
}

type Part = { path: string; doc: Document; rels: Map<string, { type: string; target: string }> };
async function readPart(zip: JSZip, path: string): Promise<Part | null> {
  const doc = await readXml(zip, path);
  return doc ? { path, doc, rels: await readRels(zip, path) } : null;
}
const relTarget = (p: Part | null, type: string) => p && [...p.rels.values()].find((r) => r.type === type)?.target;

function readTheme(doc: Document | null): Ctx["theme"] {
  const colors: Record<string, string> = {};
  const root = doc?.documentElement;
  const scheme = at(root, "themeElements/clrScheme");
  for (const c of kids(scheme)) {
    const v = kids(c)[0];
    if (v) colors[c.localName] = v.localName === "sysClr" ? attr(v, "lastClr") ?? "000000" : attr(v, "val") ?? "000000";
  }
  const font = (name: string) => {
    const f = at(root, `themeElements/fontScheme/${name}`);
    return { latin: attr(kid(f, "latin"), "typeface") || undefined, ea: attr(kid(f, "ea"), "typeface") || undefined };
  };
  return { colors, major: font("majorFont"), minor: font("minorFont") };
}

// ---------- 図形の位置 ----------
type Box = { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean };
/** グループの子座標 → スライド座標の変換 */
type Xf = { ox: number; oy: number; sx: number; sy: number; rot: number };
const IDENT: Xf = { ox: 0, oy: 0, sx: 1, sy: 1, rot: 0 };

function readXfrm(x: El | null): Box | null {
  if (!x) return null;
  const off = kid(x, "off"), ext = kid(x, "ext");
  if (!off || !ext) return null;
  return {
    x: px(attr(off, "x")), y: px(attr(off, "y")), w: px(attr(ext, "cx")), h: px(attr(ext, "cy")),
    rot: Number(attr(x, "rot") ?? 0) / 60000, flipH: attr(x, "flipH") === "1", flipV: attr(x, "flipV") === "1",
  };
}
const applyXf = (b: Box, t: Xf): Box => ({ ...b, x: t.ox + b.x * t.sx, y: t.oy + b.y * t.sy, w: b.w * t.sx, h: b.h * t.sy, rot: b.rot + t.rot });

// ---------- プレースホルダー（スライド → レイアウト → マスター）の継承 ----------
type Ph = { type: string; idx: string | null };
const phOf = (sp: El): Ph | null => {
  const ph = at(sp, "nvSpPr/nvPr/ph") ?? at(sp, "nvPicPr/nvPr/ph");
  return ph ? { type: attr(ph, "type") ?? "body", idx: attr(ph, "idx") } : null;
};
function findPh(part: Part | null, ph: Ph): El | null {
  if (!part) return null;
  const sps = Array.from(part.doc.getElementsByTagNameNS("*", "sp"));
  const norm = (t: string) => (t === "ctrTitle" ? "title" : t === "subTitle" ? "body" : t);
  return (ph.idx !== null && sps.find((s) => phOf(s)?.idx === ph.idx))
    || sps.find((s) => { const p = phOf(s); return p && norm(p.type) === norm(ph.type); })
    || null;
}

type Chain = { layout: Part | null; master: Part | null };
/** 図形の継承チェーン（自分 → レイアウトの同じプレースホルダー → マスターの同じプレースホルダー） */
function inheritChain(sp: El, chain: Chain): El[] {
  const ph = phOf(sp);
  if (!ph) return [sp];
  return [sp, findPh(chain.layout, ph), findPh(chain.master, ph)].filter(Boolean) as El[];
}
function txStyleOf(sp: El, chain: Chain, ctx: Ctx): El | null {
  const ph = phOf(sp);
  const styles = at(chain.master?.doc.documentElement, "txStyles");
  if (!ph) return kid(styles, "otherStyle") ?? ctx.defaultTextStyle;
  if (ph.type === "title" || ph.type === "ctrTitle") return kid(styles, "titleStyle");
  if (["body", "subTitle", "obj"].includes(ph.type) || ph.idx !== null && ph.type === "body") return kid(styles, "bodyStyle");
  return kid(styles, "otherStyle");
}

// ---------- テキスト ----------
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;
const NO_LINE_START = /^[、。，．・：；？！ー」』）】〕〉》”’ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々!),.:;?\]}]/;

let measureCtx: CanvasRenderingContext2D | null = null;
/** 枠の幅で折り返す（PowerPoint は自動で折り返すが、このエディタは改行しか見ないため） */
function wrap(text: string, width: number, font: string, size: number, weight: number, spacing: number): string[] {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const ctx = measureCtx!;
  ctx.font = `${weight} ${size}px '${font}', 'Noto Sans JP', sans-serif`;
  const measure = (s: string) => ctx.measureText(s).width + s.length * spacing * size;
  if (width <= 0 || measure(text) <= width) return [text];
  // CJK は 1 文字ずつ、欧文は単語（後ろの空白込み）単位で折り返す
  const tokens = text.match(/[　-ヿ㐀-鿿豈-﫿＀-￯]|[^\s　-ヿ㐀-鿿豈-﫿＀-￯]+\s*|\s+/g) ?? [text];
  const lines: string[] = [];
  let cur = "";
  for (const t of tokens) {
    if (cur && measure(cur + t.trimEnd()) > width && !NO_LINE_START.test(t)) {
      lines.push(cur.trimEnd());
      cur = t.trimStart();
    } else cur += t;
  }
  if (cur) lines.push(cur.trimEnd());
  return lines;
}

type RunStyle = { size: number; bold: boolean; italic: boolean; color: string; font: string; align: "left" | "center" | "right"; lineHeight: number; spacing: number };

/** 段落・ランの書式を、継承元（レイアウト・マスター・テキストスタイル）までたどって決める関数を作る */
function textStyleResolver(sp: El, chain: Chain, ctx: Ctx, fontColor: string | undefined) {
  const sources = inheritChain(sp, chain);
  const txStyle = txStyleOf(sp, chain, ctx);
  /** 段落レベルごとの pPr 候補（近い順） */
  const lvlPrs = (lvl: number) => {
    const name = `lvl${lvl + 1}pPr`;
    return [...sources.map((s) => at(s, `txBody/lstStyle/${name}`)), at(txStyle, name), at(ctx.defaultTextStyle, name)].filter(Boolean) as El[];
  };
  /** "+mj-lt" などのテーマフォント参照を実際のフォント名へ */
  const fontName = (face: string | null): string | undefined => {
    if (!face) return undefined;
    if (face.startsWith("+mj")) return face.endsWith("ea") ? ctx.theme.major.ea : ctx.theme.major.latin;
    if (face.startsWith("+mn")) return face.endsWith("ea") ? ctx.theme.minor.ea : ctx.theme.minor.latin;
    return face;
  };
  const isTitle = ["title", "ctrTitle"].includes(phOf(sp)?.type ?? "");
  return (p: El, r: El | null, text: string): RunStyle => {
    const pPr = kid(p, "pPr");
    const lvl = Number(attr(pPr, "lvl") ?? 0);
    const pChain = [pPr, ...lvlPrs(lvl)].filter(Boolean) as El[];
    const rChain = [r ? kid(r, "rPr") : kid(p, "endParaRPr"), ...pChain.map((x) => kid(x, "defRPr"))].filter(Boolean) as El[];
    const rAttr = (n: string) => rChain.map((x) => attr(x, n)).find((v) => v !== null) ?? null;
    const rKid = (n: string) => rChain.map((x) => kid(x, n)).find(Boolean) ?? null;
    const cjk = CJK.test(text);
    const face = (cjk && attr(rKid("ea"), "typeface")) || attr(rKid("latin"), "typeface") || (isTitle ? "+mj-lt" : "+mn-lt");
    const font = (cjk && fontName(face.replace(/lt$/, "ea"))) || fontName(face) || (cjk ? (isTitle ? ctx.theme.major.ea : ctx.theme.minor.ea) : undefined) || "Noto Sans JP";
    const color = firstColor(rKid("solidFill"), ctx) ?? (rKid("gradFill") ? firstColor(at(rKid("gradFill"), "gsLst/gs"), ctx) : undefined) ?? fontColor ?? "#000000";
    const algn = pChain.map((x) => attr(x, "algn")).find((v) => v !== null);
    const lnPct = pChain.map((x) => attr(at(x, "lnSpc/spcPct"), "val")).find((v) => v !== null);
    const spc = rAttr("spc");
    return {
      size: Number(rAttr("sz") ?? 1800) / 100 / 0.72,
      bold: rAttr("b") === "1" || rAttr("b") === "true",
      italic: rAttr("i") === "1",
      color,
      font,
      align: algn === "ctr" ? "center" : algn === "r" ? "right" : "left",
      lineHeight: 1.2 * (lnPct ? Number(lnPct) / 100000 : 1),
      // spc は 1/100 pt、sz も 1/100 pt なので比がそのまま em
      spacing: spc ? Number(spc) / Number(rAttr("sz") ?? 1800) : 0,
    };
  };
}

/** bodyPr（継承込み）から、内側の余白を除いた文字の枠と配置を読む */
function textFrame(sp: El, chain: Chain, box: Box) {
  const bodyPrs = inheritChain(sp, chain).map((s) => at(s, "txBody/bodyPr")).filter(Boolean) as El[];
  const bAttr = (n: string) => bodyPrs.map((b) => attr(b, n)).find((v) => v !== null) ?? null;
  const ins = (n: string, d: number) => px(bAttr(n) ?? String(d));
  const [l, t, r, b] = [ins("lIns", 91440), ins("tIns", 45720), ins("rIns", 91440), ins("bIns", 45720)];
  return {
    inner: { x: box.x + l, y: box.y + t, w: Math.max(1, box.w - l - r), h: Math.max(1, box.h - t - b) },
    anchor: bAttr("anchor") ?? "t",
    noWrap: bAttr("wrap") === "none",
  };
}

type Para = { text: string; style: RunStyle; before: number; after: number };

/** 段落ごとの文字列（字下げ・箇条書き記号込み）と書式。書式は最初の文字ありランのもの */
function readParagraphs(paras: El[], styleOf: ReturnType<typeof textStyleResolver>, fontScale: number): Para[] {
  const counters: number[] = []; // 段落レベルごとの番号付き箇条書きの番号
  return paras.map((p) => {
    const runs = kids(p).filter((r) => ["r", "fld", "br"].includes(r.localName));
    const text = runs.map((r) => (r.localName === "br" ? "\n" : kid(r, "t")?.textContent ?? "")).join("");
    const main = runs.find((r) => r.localName !== "br" && (kid(r, "t")?.textContent ?? "").trim()) ?? null;
    const style = styleOf(p, main, text);
    style.size *= fontScale;
    const pPr = kid(p, "pPr");
    const lvl = Number(attr(pPr, "lvl") ?? 0);
    // 箇条書き記号（段落に明示されているもののみ）
    const autoNum = kid(pPr, "buAutoNum");
    let bullet = "";
    if (text.trim() && !kid(pPr, "buNone")) {
      const ch = attr(kid(pPr, "buChar"), "char");
      if (autoNum) { counters[lvl] = (counters[lvl] ?? Number(attr(autoNum, "startAt") ?? 1) - 1) + 1; bullet = `${counters[lvl]}. `; }
      else if (ch) bullet = `${ch} `;
    }
    counters.length = autoNum ? lvl + 1 : lvl;
    const indent = lvl > 0 ? "　".repeat(lvl) : "";
    const pts = (name: string) => Number(attr(at(pPr, `${name}/spcPts`), "val") ?? 0) / 100 / 0.72;
    return { text: indent + bullet + text, style, before: pts("spcBef"), after: pts("spcAft") };
  });
}

/** 書式が同じ連続段落をまとめる（空段落は直前のまとまりに含める） */
function groupParagraphs(paras: Para[]): Para[][] {
  const key = (s: RunStyle) => [Math.round(s.size), s.bold, s.color, s.font, s.align, s.lineHeight.toFixed(2)].join("|");
  const groups: Para[][] = [];
  for (const p of paras) {
    const last = groups[groups.length - 1];
    if (last && (key(last[0].style) === key(p.style) || !p.text.trim())) last.push(p);
    else groups.push([p]);
  }
  return groups;
}

/** txBody → テキストレイヤー（書式の同じ連続段落ごと）。box は文字の入る枠 */
function textLayers(sp: El, chain: Chain, ctx: Ctx, box: Box, fontColor: string | undefined, name: string): Layer[] {
  const tx = kid(sp, "txBody");
  if (!tx) return [];
  const paras = kids(tx, "p");
  if (!paras.some((p) => kids(p).some((r) => (r.localName === "r" || r.localName === "fld") && kid(r, "t")?.textContent))) return [];
  const { inner, anchor, noWrap } = textFrame(sp, chain, box);
  const fontScale = Number(attr(at(tx, "bodyPr/normAutofit"), "fontScale") ?? 100000) / 100000;
  const groups = groupParagraphs(readParagraphs(paras, textStyleResolver(sp, chain, ctx, fontColor), fontScale));

  // まとまりごとに折り返して高さを出し、上から積む
  let y = 0;
  const blocks = groups.map((g) => {
    const s = g[0].style;
    const lines = g.flatMap((p) => p.text.split("\n").flatMap((t) => (noWrap ? [t] : wrap(t, inner.w, s.font, s.size, s.bold ? 700 : 400, s.spacing))));
    // 末尾の空段落は高さに含めない
    while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
    const h = s.size * (1.1 + (lines.length - 1) * s.lineHeight);
    const top = y + g[0].before;
    y = top + h + g[g.length - 1].after + s.size * (s.lineHeight - 1);
    return { s, text: lines.join("\n"), top, h };
  });
  // 縦位置（上・中央・下揃え）
  const shift = anchor === "ctr" ? (inner.h - y) / 2 : anchor === "b" ? inner.h - y : 0;
  return blocks.filter((m) => m.text.trim()).map((m, i) => ({
    id: `pp${++ctx.seq}`,
    name: blocks.length > 1 ? `${name} (${i + 1})` : name,
    type: "text" as const,
    text: m.text,
    font: m.s.font,
    size: Math.round(m.s.size * 10) / 10,
    weight: m.s.bold ? 700 : 400,
    lineHeight: Math.round(m.s.lineHeight * 100) / 100,
    letterSpacing: m.s.spacing ? Math.round(m.s.spacing * 1000) / 1000 : undefined,
    align: m.s.align,
    fill: m.s.color,
    skewX: m.s.italic ? -10 : undefined,
    x: round(inner.x), y: round(inner.y + shift + m.top), w: round(noWrap ? Math.max(inner.w, box.w) : inner.w), h: round(Math.max(m.h, 1)),
    rotation: box.rot || undefined,
  }));
}

// ---------- 図形 ----------
/** custGeom → 0..1 正規化の SVG path */
function custPath(geom: El, flipH: boolean, flipV: boolean, ext: { w: number; h: number }): string | null {
  const parts: string[] = [];
  for (const path of kids(at(geom, "pathLst"), "path")) {
    // w/h が無い path は図形の大きさ（EMU）の座標で書かれている
    const pw = Number(attr(path, "w") ?? 0) || ext.w || 1, ph = Number(attr(path, "h") ?? 0) || ext.h || 1;
    const pt = (p: El | null) => {
      let x = Number(attr(p, "x")) / pw, y = Number(attr(p, "y")) / ph;
      if (flipH) x = 1 - x;
      if (flipV) y = 1 - y;
      return `${+x.toFixed(4)} ${+y.toFixed(4)}`;
    };
    let last = "0 0";
    for (const c of kids(path)) {
      const pts = kids(c, "pt");
      if (c.localName === "moveTo") parts.push(`M${(last = pt(pts[0]))}`);
      else if (c.localName === "lnTo") parts.push(`L${(last = pt(pts[0]))}`);
      else if (c.localName === "cubicBezTo") { parts.push(`C${pts.map(pt).join(" ")}`); last = pt(pts[2]); }
      else if (c.localName === "quadBezTo") { parts.push(`Q${pts.map(pt).join(" ")}`); last = pt(pts[1]); }
      else if (c.localName === "close") parts.push("Z");
      else if (c.localName === "arcTo") parts.push(`L${last}`); // 円弧は近似せず直前の点で止める
    }
  }
  return parts.length ? parts.join(" ") : null;
}

/** よく使うプリセット図形の 0..1 正規化パス（調整値は既定のまま） */
const PRESET_PATHS: Record<string, string> = {
  triangle: "M0.5 0 L1 1 L0 1 Z",
  rtTriangle: "M0 0 L1 1 L0 1 Z",
  diamond: "M0.5 0 L1 0.5 L0.5 1 L0 0.5 Z",
  parallelogram: "M0.25 0 L1 0 L0.75 1 L0 1 Z",
  trapezoid: "M0.25 0 L0.75 0 L1 1 L0 1 Z",
  pentagon: "M0.5 0 L1 0.38 L0.81 1 L0.19 1 L0 0.38 Z",
  hexagon: "M0.25 0 L0.75 0 L1 0.5 L0.75 1 L0.25 1 L0 0.5 Z",
  octagon: "M0.29 0 L0.71 0 L1 0.29 L1 0.71 L0.71 1 L0.29 1 L0 0.71 L0 0.29 Z",
  homePlate: "M0 0 L0.8 0 L1 0.5 L0.8 1 L0 1 Z",
  chevron: "M0 0 L0.8 0 L1 0.5 L0.8 1 L0 1 L0.2 0.5 Z",
  rightArrow: "M0 0.25 L0.6 0.25 L0.6 0 L1 0.5 L0.6 1 L0.6 0.75 L0 0.75 Z",
  leftArrow: "M1 0.25 L0.4 0.25 L0.4 0 L0 0.5 L0.4 1 L0.4 0.75 L1 0.75 Z",
  upArrow: "M0.25 1 L0.25 0.4 L0 0.4 L0.5 0 L1 0.4 L0.75 0.4 L0.75 1 Z",
  downArrow: "M0.25 0 L0.25 0.6 L0 0.6 L0.5 1 L1 0.6 L0.75 0.6 L0.75 0 Z",
  star5: "M0.5 0 L0.62 0.38 L1 0.38 L0.69 0.62 L0.81 1 L0.5 0.76 L0.19 1 L0.31 0.62 L0 0.38 L0.38 0.38 Z",
  plus: "M0.35 0 L0.65 0 L0.65 0.35 L1 0.35 L1 0.65 L0.65 0.65 L0.65 1 L0.35 1 L0.35 0.65 L0 0.65 L0 0.35 L0.35 0.35 Z",
};
const flipPath = (d: string, h: boolean, v: boolean) =>
  !h && !v ? d : d.replace(/([\d.]+) ([\d.]+)/g, (_, x, y) => `${h ? +(1 - Number(x)).toFixed(4) : x} ${v ? +(1 - Number(y)).toFixed(4) : y}`);

const ROUND_RECTS = new Set(["roundRect", "round2SameRect", "round1Rect", "snipRoundRect"]);
const LINES = new Set(["line", "straightConnector1", "bentConnector2", "bentConnector3", "curvedConnector3"]);

/** 枠の位置・大きさ・回転（レイヤー共通のフィールド） */
const placement = (box: Box) => ({ x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h), rotation: box.rot || undefined });
type Placed = { id: string; name: string } & ReturnType<typeof placement>;

/** spPr（と shape style の既定色）→ 図形レイヤー。塗りも線もなければ null */
function shapeLayer(spPr: El | null, style: El | null, ctx: Ctx, box: Box, name: string, isConnector: boolean): Layer | null {
  const styleFill = attr(at(style, "fillRef"), "idx") !== "0" ? firstColor(at(style, "fillRef"), ctx) : undefined;
  const styleLine = attr(at(style, "lnRef"), "idx") !== "0" ? firstColor(at(style, "lnRef"), ctx) : undefined;
  const ownFill = fillOf(spPr, ctx, styleFill);
  const fill = ownFill === undefined ? styleFill ?? null : ownFill;
  const ln = kid(spPr, "ln");
  const lineFill = kid(ln, "noFill") ? undefined : fillOf(ln, ctx, styleLine) ?? styleLine;
  const stroke = typeof lineFill === "string" ? lineFill : undefined;
  const strokeWidth = stroke ? Math.max(0.5, px(attr(ln, "w") ?? "9525")) : undefined;
  if (!fill && !stroke) return null;

  const geom = kid(spPr, "prstGeom"), prst = attr(geom, "prst") ?? (kid(spPr, "custGeom") ? "cust" : "rect");
  const base: Placed = { id: `pp${++ctx.seq}`, name, ...placement(box) };
  if (isConnector || LINES.has(prst)) return stroke ? lineLayer(base, box, stroke, strokeWidth ?? 1) : null;
  const paint = { fill: fill ?? "none", stroke, strokeWidth };
  if (prst === "ellipse") return { ...base, type: "shape", shape: "ellipse", ...paint };
  if (prst === "cust") {
    const ext = kid(at(spPr, "xfrm"), "ext");
    const d = custPath(kid(spPr, "custGeom")!, box.flipH, box.flipV, { w: Number(attr(ext, "cx") ?? 0), h: Number(attr(ext, "cy") ?? 0) });
    if (d) return { ...base, type: "shape", shape: "path", d, ...paint };
  }
  if (PRESET_PATHS[prst]) return { ...base, type: "shape", shape: "path", d: flipPath(PRESET_PATHS[prst], box.flipH, box.flipV), ...paint };
  // それ以外は四角形（角丸は調整値から半径を出す）
  const adj = Number(attr(at(geom, "avLst/gd"), "fmla")?.replace("val ", "") ?? 16667) / 100000;
  const radius = ROUND_RECTS.has(prst) ? round(Math.min(box.w, box.h) * adj) : undefined;
  if (prst !== "rect" && !ROUND_RECTS.has(prst) && prst !== "cust") ctx.warn(`図形「${prst}」は四角形として読み込みました`);
  return { ...base, type: "shape", shape: "rect", ...paint, radius };
}

/** 直線。太さ 0 の枠は描けないので、水平・垂直線は線の太さぶんの枠に収める */
function lineLayer(base: Placed, box: Box, stroke: string, sw: number): Layer {
  const flat = box.h < 1 ? "h" : box.w < 1 ? "w" : null;
  const d = flat === "h" ? "M0 0.5 L1 0.5" : flat === "w" ? "M0.5 0 L0.5 1" : `M${box.flipH ? 1 : 0} ${box.flipV ? 1 : 0} L${box.flipH ? 0 : 1} ${box.flipV ? 0 : 1}`;
  return {
    ...base, type: "shape", shape: "path", d, stroke, strokeWidth: sw,
    ...(flat === "h" ? { y: round(box.y - sw / 2), h: sw } : flat === "w" ? { x: round(box.x - sw / 2), w: sw } : {}),
  };
}

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

async function imageSrc(part: Part, rid: string | null, ctx: Ctx): Promise<string | null> {
  const target = rid ? part.rels.get(rid)?.target : undefined;
  if (!target) return null;
  const ext = target.split(".").pop()!.toLowerCase();
  const mediaType = IMAGE_TYPES[ext];
  if (!mediaType) { ctx.warn(`${ext.toUpperCase()} 形式の画像は読み込めません`); return null; }
  if (!ctx.images.has(target)) {
    ctx.images.set(target, (async () => {
      const blob = await ctx.zip.file(target)?.async("blob");
      if (!blob) return null;
      try { return await ctx.opts.onImage(new Blob([blob], { type: mediaType }), mediaType); }
      catch (e) { ctx.warn(`画像を取り込めませんでした: ${(e as Error).message}`); return null; }
    })());
  }
  return ctx.images.get(target)!;
}

/** a:srcRect（トリミング）→ ImageCrop（拡大率は縦横の大きい方に合わせる近似） */
function cropOf(blipFill: El | null): ImageCrop | undefined {
  const r = kid(blipFill, "srcRect");
  if (!r) return undefined;
  const v = (n: string) => Number(attr(r, n) ?? 0) / 100000;
  const [l, t, rr, b] = [v("l"), v("t"), v("r"), v("b")];
  const s = Math.max(1 / Math.max(0.01, 1 - l - rr), 1 / Math.max(0.01, 1 - t - b));
  if (s <= 1.001) return undefined;
  return clampCrop({ scale: s, x: -l * s - (1 - s) / 2, y: -t * s - (1 - s) / 2 });
}

/** blipFill の画像 → image レイヤー。取り込めなければ null */
async function imageLayer(part: Part, blip: El | null, ctx: Ctx, box: Box, name: string, radius?: number): Promise<Layer | null> {
  const src = await imageSrc(part, rattr(kid(blip, "blip"), "embed"), ctx);
  if (!src) return null;
  return { id: `pp${++ctx.seq}`, name, type: "image", src, fit: "cover", crop: cropOf(blip), ...placement(box), radius };
}

/** spTree の子要素を順にレイヤーへ（グループは展開） */
async function walkTree(tree: El, part: Part, chain: Chain, ctx: Ctx, xf: Xf, out: Layer[], fromMaster: boolean) {
  for (const node of kids(tree)) {
    // mc:AlternateContent は互換用の Fallback（なければ Choice）の中身を読む
    const alt = node.localName === "AlternateContent" ? kid(node, "Fallback") ?? kid(node, "Choice") : null;
    for (const el of alt ? kids(alt) : [node]) await walkNode(el, part, chain, ctx, xf, out, fromMaster);
  }
}

async function walkNode(el: El, part: Part, chain: Chain, ctx: Ctx, xf: Xf, out: Layer[], fromMaster: boolean) {
  if (el.localName === "grpSp") return walkTree(el, part, chain, ctx, groupXf(el, xf), out, fromMaster);
  const cNvPr = kid(kids(el).find((c) => c.localName.startsWith("nv")), "cNvPr");
  const name = attr(cNvPr, "name") || el.localName;
  let layers: Layer[];
  switch (el.localName) {
    case "sp":
    case "cxnSp": layers = await shapeNodeLayers(el, part, chain, ctx, xf, name, fromMaster); break;
    case "pic": layers = await picLayers(el, part, chain, ctx, xf, name, fromMaster); break;
    case "graphicFrame": layers = graphicFrameLayers(el, chain, ctx, xf, name); break;
    default: return;
  }
  const hidden = attr(cNvPr, "hidden") === "1";
  for (const l of layers) {
    if (hidden) l.visible = false;
    if (fromMaster) l.locked = true; // マスター・レイアウトの飾りは動かないように
    out.push(l);
  }
}

/** グループの子座標 → スライド座標の変換を、親の変換に重ねる */
function groupXf(grp: El, xf: Xf): Xf {
  const gx = at(grp, "grpSpPr/xfrm");
  const b = readXfrm(gx);
  const chOff = kid(gx, "chOff"), chExt = kid(gx, "chExt");
  if (!b || !chOff || !chExt) return xf;
  const sx = b.w / (px(attr(chExt, "cx")) || 1), sy = b.h / (px(attr(chExt, "cy")) || 1);
  const ox = b.x - px(attr(chOff, "x")) * sx, oy = b.y - px(attr(chOff, "y")) * sy;
  return { ox: xf.ox + ox * xf.sx, oy: xf.oy + oy * xf.sy, sx: xf.sx * sx, sy: xf.sy * sy, rot: xf.rot + b.rot };
}

/** 図形の枠（自分になければレイアウト・マスターのプレースホルダーから） */
function boxOf(el: El, chain: Chain, xf: Xf): Box | null {
  const raw = inheritChain(el, chain).map((s) => readXfrm(at(s, "spPr/xfrm"))).find(Boolean);
  return raw ? applyXf(raw, xf) : null;
}

/** p:sp / p:cxnSp → 図形（または画像塗りの画像）＋中の文字 */
async function shapeNodeLayers(el: El, part: Part, chain: Chain, ctx: Ctx, xf: Xf, name: string, fromMaster: boolean): Promise<Layer[]> {
  // マスター・レイアウトのプレースホルダーは「ここに入力」の枠なので描かない
  if (fromMaster && phOf(el)) return [];
  const box = boxOf(el, chain, xf);
  if (!box) return [];
  const spPr = kid(el, "spPr");
  const style = kid(el, "style");
  const blip = kid(spPr, "blipFill");
  const shape = blip ? await imageLayer(part, blip, ctx, box, name) : shapeLayer(spPr, style, ctx, box, name, el.localName === "cxnSp");
  // 文字は図形と同じ枠・同じ角度で置く
  const text = textLayers(el, chain, ctx, box, firstColor(at(style, "fontRef"), ctx), shape ? `${name} の文字` : name);
  return shape ? [shape, ...text] : text;
}

/** p:pic → 画像（楕円・角丸の図形なら角を丸める） */
async function picLayers(el: El, part: Part, chain: Chain, ctx: Ctx, xf: Xf, name: string, fromMaster: boolean): Promise<Layer[]> {
  if (fromMaster && phOf(el)) return [];
  const box = boxOf(el, chain, xf);
  if (!box) return [];
  const geom = attr(at(el, "spPr/prstGeom"), "prst");
  const radius = geom === "ellipse" ? round(Math.min(box.w, box.h) / 2) : geom === "roundRect" ? round(Math.min(box.w, box.h) * 0.16667) : undefined;
  const layer = await imageLayer(part, kid(el, "blipFill"), ctx, box, name, radius);
  return layer ? [layer] : [];
}

/** p:graphicFrame → 表のみ読める */
function graphicFrameLayers(el: El, chain: Chain, ctx: Ctx, xf: Xf, name: string): Layer[] {
  const raw = readXfrm(kid(el, "xfrm"));
  const tbl = el.getElementsByTagNameNS("*", "tbl")[0];
  if (!raw || !tbl) { ctx.warn("グラフ・SmartArt などは読み込めません"); return []; }
  return tableLayers(tbl, applyXf(raw, xf), chain, ctx, name);
}

/** 表のセルの文字。セルの a:txBody を p:sp で包めば図形の文字と同じ処理で読める */
function cellTextLayers(tc: El, chain: Chain, ctx: Ctx, cell: { x: number; y: number; w: number }, name: string): Layer[] {
  const tb = kid(tc, "txBody");
  if (!tb) return [];
  const fake = tc.ownerDocument.createElementNS("http://schemas.openxmlformats.org/presentationml/2006/main", "p:sp");
  fake.appendChild(tb.cloneNode(true));
  return textLayers(fake, { layout: null, master: chain.master }, ctx, { ...cell, h: 0, rot: 0, flipH: false, flipV: false }, undefined, name);
}

/** 表 → セルごとの四角形＋文字。行の高さは文字が収まるまで広げる（PowerPoint と同じ） */
function tableLayers(tbl: El, box: Box, chain: Chain, ctx: Ctx, name: string): Layer[] {
  const cols = kids(at(tbl, "tblGrid"), "gridCol").map((c) => px(attr(c, "w")));
  const sum = cols.reduce((a, b) => a + b, 0);
  const sx = sum ? box.w / sum : 1;
  const rows = kids(tbl, "tr");
  const out: Layer[] = [];
  let y = box.y;
  rows.forEach((tr, ri) => {
    // 高さ 0 の行（自動）は、表全体の高さを等分した値を最低限にする
    let h = px(attr(tr, "h")) || box.h / rows.length;
    const cells: { tc: El; label: string; x: number; w: number; texts: Layer[] }[] = [];
    let x = box.x;
    kids(tr, "tc").forEach((tc, ci) => {
      const span = Number(attr(tc, "gridSpan") ?? 1);
      const w = cols.slice(ci, ci + span).reduce((a, b) => a + b, 0) * sx;
      // 結合で隠れたセルは飛ばす
      if (attr(tc, "hMerge") !== "1" && attr(tc, "vMerge") !== "1") {
        const label = `${ri + 1}-${ci + 1}`;
        const texts = cellTextLayers(tc, chain, ctx, { x, y, w }, `${name} ${label}`);
        for (const t of texts) h = Math.max(h, t.y + t.h - y + 5);
        cells.push({ tc, label, x, w, texts });
      }
      x += (cols[ci] ?? 0) * sx;
    });
    for (const { tc, label, x, w, texts } of cells) {
      const tcPr = kid(tc, "tcPr");
      const fill = fillOf(tcPr, ctx);
      const line = kid(tcPr, "lnB") ?? kid(tcPr, "lnL");
      const stroke = line ? (kid(line, "noFill") ? undefined : fillOf(line, ctx)) : "#bbbbbb";
      out.push({
        id: `pp${++ctx.seq}`, name: `${name} セル${label}`, type: "shape", shape: "rect",
        fill: fill ?? "none", stroke: typeof stroke === "string" ? stroke : undefined, strokeWidth: line ? Math.max(0.5, px(attr(line, "w") ?? "12700")) : 1,
        x: round(x), y: round(y), w: round(w), h: round(h),
      });
      const anchor = attr(tcPr, "anchor");
      const used = texts.length ? Math.max(...texts.map((t) => t.y + t.h)) - y + 5 : 0;
      const shift = anchor === "ctr" ? (h - used) / 2 : anchor === "b" ? h - used : 0;
      out.push(...texts.map((t) => ({ ...t, y: round(t.y + shift) })));
    }
    y += h;
  });
  return out;
}

/** 背景（スライド → レイアウト → マスターの順に最初に見つかったもの）。画像背景は image レイヤーとして返す */
async function backgroundOf(parts: (Part | null)[], ctx: Ctx, width: number, height: number): Promise<Layer[]> {
  const bgLayer = (fill: Paint): Layer => ({ id: "bg", name: "背景", type: "background", fill, x: 0, y: 0, w: width, h: height });
  for (const p of parts) {
    const bg = at(p?.doc.documentElement, "cSld/bg");
    if (!p || !bg) continue;
    const bgPr = kid(bg, "bgPr");
    if (bgPr) {
      const blip = kid(bgPr, "blipFill");
      if (!blip) return [bgLayer(fillOf(bgPr, ctx) ?? "#ffffff")];
      const src = await imageSrc(p, rattr(kid(blip, "blip"), "embed"), ctx);
      return [
        bgLayer("#ffffff"),
        ...(src ? [{ id: `pp${++ctx.seq}`, name: "背景画像", type: "image" as const, src, fit: "cover" as const, x: 0, y: 0, w: width, h: height, locked: true }] : []),
      ];
    }
    const ref = kid(bg, "bgRef");
    if (ref) return [bgLayer(firstColor(ref, ctx) ?? "#ffffff")];
  }
  return [bgLayer("#ffffff")];
}

/** スライドが使うテーマ（色・フォント）とカラーマップ（bg1 → lt1 など）を ctx に設定する */
function applySlideTheme(ctx: Ctx, theme: Part | null, layout: Part | null, master: Part | null) {
  ctx.theme = readTheme(theme?.doc ?? null);
  // レイアウトにカラーマップの上書きがあればそちら
  const mapEl = at(layout?.doc.documentElement, "clrMapOvr/overrideClrMapping") ?? kid(master?.doc.documentElement, "clrMap");
  ctx.clrMap = Object.fromEntries(Array.from(mapEl?.attributes ?? []).map((a) => [a.name, a.value]));
}

/** スライドのノート（台本）。ノートページの本文のプレースホルダーの文字を段落ごとに改行でつなぐ */
async function notesOf(zip: JSZip, slide: Part): Promise<string | undefined> {
  const path = relTarget(slide, "notesSlide");
  const doc = path ? await readXml(zip, path) : null;
  const tree = at(doc?.documentElement, "cSld/spTree");
  const body = kids(tree, "sp").find((sp) => attr(at(sp, "nvSpPr/nvPr/ph"), "type") === "body");
  if (!body) return undefined;
  const text = kids(kid(body, "txBody"), "p")
    .map((p) => kids(p).map((r) => (r.localName === "br" ? "\n" : r.localName === "r" || r.localName === "fld" ? kid(r, "t")?.textContent ?? "" : "")).join(""))
    .join("\n")
    .trim();
  return text || undefined;
}

/** 1 枚のスライド → レイヤー（背景 → マスター・レイアウトの飾り → スライドの図形の順） */
async function slideLayers(slide: Part, layout: Part | null, master: Part | null, ctx: Ctx, width: number, height: number): Promise<Layer[]> {
  const layers = await backgroundOf([slide, layout, master], ctx, width, height);
  // マスター・レイアウトの飾り（ロゴや帯など）。showMasterSp="0" なら出さない
  const showMaster = (p: Part | null) => attr(p?.doc.documentElement, "showMasterSp") !== "0";
  const masterOnly: Chain = { layout: null, master };
  if (showMaster(slide) && showMaster(layout) && master) await walkTree(at(master.doc.documentElement, "cSld/spTree")!, master, masterOnly, ctx, IDENT, layers, true);
  if (showMaster(slide) && layout) await walkTree(at(layout.doc.documentElement, "cSld/spTree")!, layout, masterOnly, ctx, IDENT, layers, true);
  const tree = at(slide.doc.documentElement, "cSld/spTree");
  if (tree) await walkTree(tree, slide, { layout, master }, ctx, IDENT, layers, false);
  return layers;
}

export async function importPptx(file: Blob, fileName: string, opts: PptxImportOptions): Promise<PptxImportResult> {
  const zip = await JSZip.loadAsync(file);
  const pres = await readPart(zip, "ppt/presentation.xml");
  if (!pres) throw new Error("PowerPoint（.pptx）ファイルではありません");
  const root = pres.doc.documentElement;
  const sz = kid(root, "sldSz");
  const width = Math.round(px(attr(sz, "cx") ?? "9144000"));
  const height = Math.round(px(attr(sz, "cy") ?? "6858000"));
  const warnings = new Map<string, number>();
  const ctx: Ctx = {
    zip, theme: { colors: {}, major: {}, minor: {} }, clrMap: {}, defaultTextStyle: kid(root, "defaultTextStyle"), opts,
    images: new Map(), warn: (m) => warnings.set(m, (warnings.get(m) ?? 0) + 1), seq: 0,
  };
  const slidePaths = kids(kid(root, "sldIdLst"), "sldId").map((s) => pres.rels.get(rattr(s, "id") ?? "")?.target).filter(Boolean) as string[];
  const name = fileName.replace(/\.pptx$/i, "");
  // レイアウト・マスター・テーマは複数のスライドで共有されるので 1 度だけ読む
  const shared = new Map<string, Promise<Part | null>>();
  const load = (path: string | undefined | null) => {
    if (!path) return Promise.resolve(null);
    if (!shared.has(path)) shared.set(path, readPart(zip, path));
    return shared.get(path)!;
  };

  const slides: PosterSpec[] = [];
  for (const [i, path] of slidePaths.entries()) {
    if (opts.signal?.aborted) throw new DOMException("キャンセルしました", "AbortError");
    opts.onProgress?.(i, slidePaths.length);
    const slide = await readPart(zip, path);
    if (!slide) continue;
    const layout = await load(relTarget(slide, "slideLayout"));
    const master = await load(relTarget(layout, "slideMaster"));
    applySlideTheme(ctx, await load(relTarget(master, "theme")), layout, master);
    ctx.seq = 0;
    const notes = await notesOf(zip, slide);
    // 画面切り替え（新しい PowerPoint は mc:AlternateContent に包んで書くので、子孫から最初のものを読む）
    const transition = readTransition(slide.doc.getElementsByTagNameNS("*", "transition")[0]);
    slides.push({
      version: 1,
      meta: { title: `${name} ${i + 1}`, width, height },
      theme: "ocean",
      layers: await slideLayers(slide, layout, master, ctx, width, height),
      ...(notes ? { notes } : {}),
      ...(transition ? { transition } : {}),
    });
  }
  opts.onProgress?.(slidePaths.length, slidePaths.length);
  if (!slides.length) throw new Error("スライドが見つかりませんでした");
  return { name, width, height, slides, warnings: [...warnings].map(([m, n]) => (n > 1 ? `${m}（${n} 件）` : m)) };
}
