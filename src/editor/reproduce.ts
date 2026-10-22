import type { Layer, PosterSpec } from "../schema";
import { readDataUrl, type RefImage } from "./api";

/**
 * 参考画像の再現（A4 モード）。
 * - 参考画像はポスターの座標系（幅 1000px）に縮めて AI に渡し、座標を 1:1 で測らせる
 * - AI が写真・イラストの範囲を src: "ref:x,y,w,h" で返したら、元の解像度の参考画像から切り抜いて取り込む
 * - 参考画像そのものは非表示・ロックの「比較用」レイヤーとして最前面に持っておく（見比べ・仕上げの修正で使う）
 */

export const REF_OVERLAY_ID = "reference-overlay";
const POSTER_WIDTH = 1000;
const A4_HEIGHT = 1414;

export const loadImage = (src: string) => new Promise<HTMLImageElement>((res, rej) => {
  const img = new Image();
  img.onload = () => res(img);
  img.onerror = () => rej(new Error("参考画像を読み込めませんでした"));
  img.src = src;
});

/** 再現するポスターの大きさ。幅 1000px で縦横比は参考画像に合わせる（A4 に近ければ A4 の 1000×1414 にそろえる） */
export function referenceSize(img: HTMLImageElement) {
  const height = Math.round((POSTER_WIDTH * img.naturalHeight) / img.naturalWidth);
  return { width: POSTER_WIDTH, height: Math.abs(height - A4_HEIGHT) <= A4_HEIGHT * 0.02 ? A4_HEIGHT : height };
}

function drawTo(img: HTMLImageElement, w: number, h: number, sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  c.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
const toBlob = (c: HTMLCanvasElement, type = "image/png", quality?: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("画像に変換できませんでした"))), type, quality));

/** ポスターの大きさに縮めた参考画像（AI に渡す・比較用レイヤーにする） */
export async function scaledReference(img: HTMLImageElement, width: number, height: number) {
  const blob = await toBlob(drawTo(img, width, height));
  return { blob, ref: await blobToRef(blob) };
}

export const blobToRef = async (blob: Blob): Promise<RefImage> =>
  ({ mediaType: (blob.type || "image/png") as RefImage["mediaType"], data: (await readDataUrl(blob)).split(",")[1] });

const REF_SRC = /^ref:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:;([\d.,\s-]*))?$/;

/** "x1 y1, x2 y2, ..." → 頂点の列（3 点未満なら undefined） */
function parsePolygon(s?: string) {
  const nums = (s ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
  if (nums.length < 6 || nums.some((n) => !Number.isFinite(n))) return undefined;
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

/**
 * spec 内の src: "ref:x,y,w,h" を、参考画像のその範囲を切り抜いて取り込んだ画像のパスに置き換える。
 * "ref:x,y,w,h;x1 y1,x2 y2,..." と輪郭（ポスター座標の多角形）があれば、その外側は透明にして切り抜く。
 * 切り抜いた画像がずれて見えないよう、レイヤーの位置・大きさは切り抜き範囲に合わせ、回転は外す。
 * 範囲が読めない・画像の外なら src を消す（asset があれば画像生成に回る）
 */
export async function resolveRefCrops(spec: PosterSpec, img: HTMLImageElement, upload: (blob: Blob) => Promise<string>): Promise<PosterSpec> {
  const out = structuredClone(spec);
  // ox, oy: 親グループまでの平行移動（親が回転していれば位置合わせはしない）
  const nodes: { o: Record<string, unknown>; ox: number; oy: number; rotated: boolean }[] = [];
  const walk = (layers: Layer[], ox: number, oy: number, rotated: boolean) => {
    for (const l of layers) {
      const o = l as unknown as Record<string, unknown>;
      if (typeof o.src === "string" && o.src.startsWith("ref:")) nodes.push({ o, ox, oy, rotated });
      if (l.type === "component" && typeof l.props?.src === "string" && l.props.src.startsWith("ref:")) nodes.push({ o: l.props, ox, oy, rotated: true });
      if (l.type === "group") walk(l.children, ox + l.x, oy + l.y, rotated || !!l.rotation);
    }
  };
  walk(out.layers, 0, 0, false);
  if (!nodes.length) return spec;
  const kx = img.naturalWidth / spec.meta.width;
  const ky = img.naturalHeight / spec.meta.height;
  await Promise.all(nodes.map(async ({ o, ox, oy, rotated }) => {
    const m = String(o.src).match(REF_SRC);
    delete o.src;
    if (!m) return;
    const [x, y, w, h] = m.slice(1, 5).map(Number);
    const poly = parsePolygon(m[5]);
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(spec.meta.width, x + w), y1 = Math.min(spec.meta.height, y + h);
    if (x1 - x0 < 2 || y1 - y0 < 2) return;
    const sw = (x1 - x0) * kx, sh = (y1 - y0) * ky;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw));
    c.height = Math.max(1, Math.round(sh));
    const ctx = c.getContext("2d")!;
    if (poly) {
      ctx.beginPath();
      poly.forEach(([px, py], i) => ctx[i ? "lineTo" : "moveTo"](((px - x0) * kx * c.width) / sw, ((py - y0) * ky * c.height) / sh));
      ctx.closePath();
      ctx.clip();
    }
    ctx.drawImage(img, x0 * kx, y0 * ky, sw, sh, 0, 0, c.width, c.height);
    o.src = await upload(await toBlob(c));
    if (rotated || o.type !== "image") return;
    Object.assign(o, { x: x0 - ox, y: y0 - oy, w: x1 - x0, h: y1 - y0, fit: "cover" });
    delete o.rotation;
    delete o.crop;
  }));
  return out;
}

export const overlayOf = (spec: PosterSpec) => spec.layers.find((l) => l.id === REF_OVERLAY_ID && l.type === "image") as Extract<Layer, { type: "image" }> | undefined;

/** 比較用レイヤーを除いた spec（AI に渡す・描画して見比べる用） */
export const withoutOverlay = (spec: PosterSpec): PosterSpec => ({ ...spec, layers: spec.layers.filter((l) => l.id !== REF_OVERLAY_ID) });

/** 参考画像を比較用レイヤーとして最前面に置く（既定は非表示・ロック・半透明。表示すると重ねて見比べられる） */
export function withOverlay(spec: PosterSpec, overlay: Layer | string): PosterSpec {
  const layer: Layer = typeof overlay === "string"
    ? { id: REF_OVERLAY_ID, name: "参考画像（比較用）", type: "image", src: overlay, fit: "cover", x: 0, y: 0, w: spec.meta.width, h: spec.meta.height, opacity: 0.5, visible: false, locked: true }
    : overlay;
  return { ...spec, layers: [...withoutOverlay(spec).layers, layer] };
}

/**
 * 画像を w:h の比率に中央で切り抜く（解像度は元のまま）。比率がほぼ同じならそのまま返す。
 * Instagram の再現で、ChatGPT が作った 2:3 などの画像を投稿の比率にそろえる
 */
export async function fitToRatio(img: HTMLImageElement, w: number, h: number) {
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const target = w / h;
  if (Math.abs(iw / ih - target) < 0.005 * target) return img;
  const sw = iw / ih > target ? ih * target : iw;
  const sh = iw / ih > target ? ih : iw / target;
  const c = drawTo(img, sw, sh, (iw - sw) / 2, (ih - sh) / 2, sw, sh);
  return loadImage(URL.createObjectURL(await toBlob(c)));
}
