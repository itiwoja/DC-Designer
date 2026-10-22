import type { Layer, PosterSpec } from "../schema";
import { cropTarget } from "../render/ImageBox";
import { aabb } from "./canvas";

/**
 * A4 チェック（ポスターモード）。
 * ポスターが A4 の縦横比か、書き出す PNG が A4 300dpi になるか、印刷で切れたり読めなくなったりする要素が無いかを調べる。
 * React 非依存（画像の解像度だけは呼び出し側が読み込んだ大きさを渡す）
 */

/** A4 の大きさ（mm、縦向き） */
export const A4_MM = { w: 210, h: 297 } as const;
/** 印刷の解像度 */
export const PRINT_DPI = 300;
/** A4 300dpi の画素数（縦向き） */
export const A4_PX = { w: mmToPx(A4_MM.w), h: mmToPx(A4_MM.h) } as const;
/** 縦横比のずれがこの割合までなら A4 とみなす（1000×1414 は 0.01% ずれ） */
export const RATIO_TOLERANCE = 0.005;
/** 家庭用・事務用プリンターで印刷されないことがある端の幅（mm） */
export const SAFE_MARGIN_MM = 5;
/** これより小さい文字は印刷すると読みにくい（pt） */
export const MIN_TEXT_PT = 7;
/** 画像の実効解像度がこれ未満だと印刷で粗く見える（dpi） */
export const MIN_IMAGE_DPI = 150;

function mmToPx(mm: number, dpi = PRINT_DPI) { return Math.round((mm / 25.4) * dpi); }

export type Orientation = "portrait" | "landscape";

/** ポスターの大きさが A4 かどうか */
export function a4Fit(width: number, height: number) {
  const orientation: Orientation = width > height ? "landscape" : "portrait";
  const ideal = A4_MM.h / A4_MM.w;
  const ratio = Math.max(width, height) / Math.min(width, height);
  const error = Math.abs(ratio - ideal) / ideal;
  const page = orientation === "portrait" ? A4_MM : { w: A4_MM.h, h: A4_MM.w };
  return {
    orientation,
    ratio,
    /** A4 の縦横比からのずれ（割合） */
    error,
    ok: error <= RATIO_TOLERANCE,
    /** ポスターの 1 単位が何 mm になるか（幅を A4 に合わせたとき） */
    mmPerUnit: page.w / width,
    /** この比率のまま幅を A4 に合わせたときの高さ（mm） */
    heightMm: (height * page.w) / width,
    page,
  };
}

/** A4 にそろえた大きさ（幅はそのまま、高さを A4 の比率に） */
export function a4Size(width: number, height: number): { width: number; height: number } {
  const ideal = A4_MM.h / A4_MM.w;
  return width > height ? { width, height: Math.round(width / ideal) } : { width, height: Math.round(width * ideal) };
}

/** PNG に書き出す画素数。A4 なら A4 300dpi ちょうど、そうでなければ幅を A4 300dpi に合わせる */
export function exportPixels(width: number, height: number): { w: number; h: number } {
  const fit = a4Fit(width, height);
  const px = fit.orientation === "portrait" ? A4_PX : { w: A4_PX.h, h: A4_PX.w };
  if (fit.ok) return px;
  return { w: px.w, h: Math.round((height * px.w) / width) };
}

export type A4Issue = {
  level: "error" | "warn";
  kind: "outside" | "cut" | "margin" | "small-text" | "low-res";
  layerId: string;
  name: string;
  text: string;
};

const nameOf = (l: Layer) => l.name ?? (l.type === "text" ? l.text.split("\n")[0].slice(0, 16) : l.id);
const shown = (l: Layer, theme: string) => l.visible !== false && (!l.themes || l.themes.includes(theme));

/** 部品の中で文字を持つ props */
const TEXT_PROPS = ["text", "label", "caption"];

/** 切れたら困る中身を持つレイヤーか（文字・QR・文字入りの部品・それらを含むグループ） */
function carriesInfo(l: Layer): boolean {
  if (l.type === "text") return !!l.text.trim();
  if (l.type === "group") return l.children.some(carriesInfo);
  if (l.type !== "component") return false;
  if (l.component === "qr" || l.component === "checklist") return true;
  return TEXT_PROPS.some((k) => typeof l.props?.[k] === "string" && l.props[k].trim());
}

/** 文字の大きさ（ポスター単位）の最小値。グループの中も見る */
function minTextSize(l: Layer, theme: string): number {
  if (!shown(l, theme)) return Infinity;
  if (l.type === "text") return l.text.trim() ? l.size : Infinity;
  if (l.type === "group") return Math.min(Infinity, ...l.children.map((c) => minTextSize(c, theme)));
  return Infinity;
}

/**
 * 印刷で困るレイヤーを洗い出す。
 * imageSizes は画像の src → 本来の画素数（分かっているものだけ）
 */
export function a4Issues(spec: PosterSpec, imageSizes: Map<string, { w: number; h: number }> = new Map()): A4Issue[] {
  const W = spec.meta.width, H = spec.meta.height;
  const { mmPerUnit } = a4Fit(W, H);
  const margin = SAFE_MARGIN_MM / mmPerUnit;
  const issues: A4Issue[] = [];
  for (const l of spec.layers) {
    if (l.type === "background" || !shown(l, spec.theme)) continue;
    const b = aabb(l);
    const name = nameOf(l);
    const base = { layerId: l.id, name };
    // 文字・QR・文字入りの部品は切れたら困る。図形・画像・飾りの部品は端まで塗り足すことが多いので、ページの外に出たものだけ見る
    const content = carriesInfo(l);
    if (b.x >= W || b.y >= H || b.x + b.w <= 0 || b.y + b.h <= 0) {
      issues.push({ ...base, level: "warn", kind: "outside", text: "ページの外にあり、印刷されません" });
      continue;
    }
    if (content) {
      const over = b.x < -0.5 || b.y < -0.5 || b.x + b.w > W + 0.5 || b.y + b.h > H + 0.5;
      if (over) issues.push({ ...base, level: "error", kind: "cut", text: "ページの端からはみ出していて、切れて印刷されます" });
      else if (b.x < margin || b.y < margin || b.x + b.w > W - margin || b.y + b.h > H - margin) {
        issues.push({ ...base, level: "warn", kind: "margin", text: `端から ${SAFE_MARGIN_MM}mm 以内にあり、プリンターによっては切れます` });
      }
    }
    const size = minTextSize(l, spec.theme);
    if (size < Infinity) {
      const pt = (size * mmPerUnit * 72) / 25.4;
      if (pt < MIN_TEXT_PT) issues.push({ ...base, level: "warn", kind: "small-text", text: `文字が ${pt.toFixed(1)}pt で、印刷すると読みにくい大きさです（${MIN_TEXT_PT}pt 以上がおすすめ）` });
    }
    const img = cropTarget(l);
    const nat = img && imageSizes.get(img.src);
    if (img && nat && nat.w > 0 && nat.h > 0) {
      const dpi = imageDpi(l, img.fit, img.crop?.scale ?? 1, nat, mmPerUnit);
      if (dpi < MIN_IMAGE_DPI) issues.push({ ...base, level: "warn", kind: "low-res", text: `画像が ${Math.round(dpi)}dpi 相当で、印刷すると粗く見えます（${MIN_IMAGE_DPI}dpi 以上がおすすめ）` });
    }
  }
  return issues;
}

/** 画像を印刷したときの実効解像度（dpi） */
export function imageDpi(box: { w: number; h: number }, fit: "cover" | "contain", scale: number, nat: { w: number; h: number }, mmPerUnit: number) {
  const k = (fit === "cover" ? Math.max(box.w / nat.w, box.h / nat.h) : Math.min(box.w / nat.w, box.h / nat.h)) * scale;
  return 25.4 / (k * mmPerUnit);
}

// ---------- A4 に整える（/a4） ----------

/** 文字の最小の大きさ（ポスター単位） */
export function minTextUnits(width: number, height: number) {
  return Math.ceil((MIN_TEXT_PT * 25.4) / 72 / a4Fit(width, height).mmPerUnit);
}
/** 端から空ける幅（ポスター単位） */
export function safeMarginUnits(width: number, height: number) {
  return Math.ceil(SAFE_MARGIN_MM / a4Fit(width, height).mmPerUnit);
}

const round = (v: number) => Math.round(v);

/** レイヤーを中心を保ったまま k 倍にする（文字は文字の大きさも） */
function scaleLayer(l: Layer, k: number): Layer {
  const w = l.w * k, h = l.h * k;
  const out = { ...l, x: round(l.x + (l.w - w) / 2), y: round(l.y + (l.h - h) / 2), w: round(w), h: round(h) } as Layer;
  if (out.type === "text") out.size = Math.max(1, round(out.size * k));
  return out;
}

/**
 * ポスターを手元で A4 に整える（AI を使わない部分）。
 * 1. A4 の縦横比でなければ、幅を保って高さを A4 にし、レイヤーの縦の位置を新しい高さに合わせて配り直す
 *    （ページの高さほどある背景の飾りは縦に伸ばす）
 * 2. 文字・QR・文字入りの部品を、端から 5mm 内側に収める（入りきらない大きさなら縮める）
 */
export function fitToA4(spec: PosterSpec): { spec: PosterSpec; resized: boolean; moved: string[]; shrunk: string[] } {
  const W0 = spec.meta.width, H0 = spec.meta.height;
  const resized = !a4Fit(W0, H0).ok;
  const { width: W, height: H } = resized ? a4Size(W0, H0) : { width: W0, height: H0 };
  const ky = H / H0;
  const margin = safeMarginUnits(W, H);
  const moved: string[] = [], shrunk: string[] = [];
  const layers = spec.layers.map((l0): Layer => {
    if (l0.type === "background") return l0;
    let l: Layer = l0;
    if (resized) {
      l = l.h >= H0 * 0.9
        ? { ...l, y: round(l.y * ky), h: round(l.h * ky) } as Layer
        : { ...l, y: round((l.y + l.h / 2) * ky - l.h / 2) } as Layer;
    }
    if (!shown(l, spec.theme) || !carriesInfo(l)) return l;
    let b = aabb(l);
    // グループは中身の位置が相対なので、縮めずに動かすだけにする
    const k = l.type === "group" ? 1 : Math.min(1, (W - margin * 2) / b.w, (H - margin * 2) / b.h);
    if (k < 1) { l = scaleLayer(l, k); b = aabb(l); shrunk.push(l.id); }
    const dx = b.x < margin ? margin - b.x : b.x + b.w > W - margin ? W - margin - (b.x + b.w) : 0;
    const dy = b.y < margin ? margin - b.y : b.y + b.h > H - margin ? H - margin - (b.y + b.h) : 0;
    if (dx || dy) {
      // 回転していると端が小数になるので、丸めても内側に残るよう、ずらす向きに切り上げる
      const toward = (v: number, d: number) => (d > 0 ? Math.ceil(v) : d < 0 ? Math.floor(v) : v);
      l = { ...l, x: toward(l.x + dx, dx), y: toward(l.y + dy, dy) } as Layer;
      if (!shrunk.includes(l.id)) moved.push(l.id);
    }
    return l;
  });
  return { spec: { ...spec, meta: { ...spec.meta, width: W, height: H }, layers }, resized, moved, shrunk };
}

/** AI に頼む「A4 に整えて」の指示。extra はユーザーが /a4 の後ろに書いた内容 */
export function a4Instruction(spec: PosterSpec, issues: A4Issue[], extra = "") {
  const W = spec.meta.width, H = spec.meta.height;
  const margin = safeMarginUnits(W, H), minSize = minTextUnits(W, H);
  const lines = [
    `このポスターを A4（${a4Fit(W, H).orientation === "portrait" ? "縦 210×297mm" : "横 297×210mm"}）に印刷する前提で、きれいに整えてください。`,
    `- キャンバスの大きさ（${W}×${H}）は変えない。デザインの雰囲気・内容・配色は保つ`,
    `- 文字・QR コード・文字入りの部品は、すべて端から ${margin} 以上内側（x=${margin}〜${W - margin}, y=${margin}〜${H - margin}）に収める`,
    `- 文字の大きさ（size）は ${minSize} 以上（A4 で ${MIN_TEXT_PT}pt 以上）にする`,
    "- 要素どうしの重なりや窮屈なところ、逆に大きく空いたところを直し、上下左右の余白と間隔をそろえてバランスよく配置する",
    "- 背景の図形・飾りは端まで広げてよい",
  ];
  if (issues.length) lines.push("", "いま見つかっている注意:", ...issues.map((i) => `- ${i.name}（${i.layerId}）: ${i.text}`));
  if (extra.trim()) lines.push("", `追加の指示: ${extra.trim()}`);
  return lines.join("\n");
}

// ---------- PNG の解像度情報 ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const isPng = (b: Uint8Array) => PNG_SIG.every((v, i) => b[i] === v);

/** PNG に解像度（pHYs）を書き込む。印刷やほかのアプリで A4 の大きさとして開かれるようにする */
export function setPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  if (!isPng(png)) return png;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  cv.setUint32(8, ppm);
  cv.setUint32(12, ppm);
  chunk[16] = 1; // 単位はメートル
  cv.setUint32(17, crc32(chunk.subarray(4, 17)));
  // 既存の pHYs を除き、IHDR の直後に入れる
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let off = 8;
  while (off + 8 <= png.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    const end = off + 12 + len;
    if (type !== "pHYs") parts.push(png.subarray(off, end));
    if (type === "IHDR") parts.push(chunk);
    off = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** PNG の画素数と解像度を読む（解像度が無ければ dpi は null） */
export function readPngInfo(png: Uint8Array): { w: number; h: number; dpi: number | null } | null {
  if (!isPng(png) || png.length < 24) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const w = view.getUint32(16), h = view.getUint32(20);
  let dpi: number | null = null;
  let off = 8;
  while (off + 8 <= png.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    if (type === "pHYs" && png[off + 16] === 1) dpi = Math.round(view.getUint32(off + 8) * 0.0254);
    if (type === "IDAT") break;
    off += 12 + len;
  }
  return { w, h, dpi };
}

/** 書き出した PNG が A4 になっているか（実寸 mm と A4 との差） */
export function pngA4Report(info: { w: number; h: number; dpi: number | null }) {
  const dpi = info.dpi ?? 96;
  const wMm = (info.w / dpi) * 25.4, hMm = (info.h / dpi) * 25.4;
  const page = info.w > info.h ? { w: A4_MM.h, h: A4_MM.w } : A4_MM;
  const ok = info.dpi != null && Math.abs(wMm - page.w) <= 0.5 && Math.abs(hMm - page.h) <= 0.5;
  return { wMm, hMm, ok, dpi: info.dpi };
}
