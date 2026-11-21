import type { AssetRequest, Layer, PosterSpec } from "../schema";

/**
 * 画像を生成する前に、その画像の枠の中で「前面のレイヤー（文字・図形など）がどこを占めるか」を描いた下書き。
 * 画像生成に渡して、文字を載せる場所を避けた構図の絵を作らせる。
 */

export type Rect = { x: number; y: number; w: number; h: number };

/** 下書きに描く前面レイヤーの色（中間グレー）と背景 */
const GUIDE_GRAY = "#9a9a9a";
const GUIDE_BG = "#ffffff";
/** 紙面のこの割合に満たない小さな画像には下書きを作らない */
const MIN_COVERAGE = 0.05;
/** これより薄いレイヤーは、文字を載せる場所とみなさない */
const MIN_OPACITY = 0.15;
/** 下書きの長辺の最大ピクセル数 */
const MAX_GUIDE_PX = 1024;

/** 生成対象の画像レイヤーが持つ asset（image、または props.asset を持つ component） */
export function layerAsset(layer: Layer): AssetRequest | undefined {
  if (layer.type === "image") return layer.asset;
  if (layer.type === "component") {
    const a = layer.props?.asset;
    return a && typeof a === "object" ? (a as AssetRequest) : undefined;
  }
}

/** 回転を含めた外接矩形 */
export function boundsOf(l: Pick<Layer, "x" | "y" | "w" | "h" | "rotation">): Rect {
  const rad = ((l.rotation ?? 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  const w = l.w * c + l.h * s, h = l.w * s + l.h * c;
  const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 紙面の内側に切り詰める */
function clampToPoster(r: Rect, width: number, height: number): Rect {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return { x, y, w: Math.min(width, r.x + r.w) - x, h: Math.min(height, r.y + r.h) - y };
}

/** 前面のレイヤーを、形だけ分かる中間グレーの塗りにする（色・影・縁取り・アニメーションは落とす） */
export function grayOut(layer: Layer): Layer {
  const base = { id: layer.id, x: layer.x, y: layer.y, w: layer.w, h: layer.h, rotation: layer.rotation };
  switch (layer.type) {
    case "text":
      return { ...layer, fill: GUIDE_GRAY, colorRuns: undefined, outlines: undefined, shadow: undefined, blend: undefined, opacity: undefined, animation: undefined, themes: undefined };
    case "shape":
      return {
        ...layer,
        fill: layer.fill === undefined && layer.stroke ? undefined : GUIDE_GRAY,
        stroke: layer.stroke ? GUIDE_GRAY : undefined,
        shadow: undefined, blend: undefined, opacity: undefined, animation: undefined, themes: undefined,
      };
    case "group":
      return { ...layer, children: layer.children.map(grayOut), shadow: undefined, blend: undefined, opacity: undefined, animation: undefined, themes: undefined };
    case "image":
      return { ...base, type: "shape", shape: "rect", fill: GUIDE_GRAY, radius: layer.radius, visible: layer.visible };
    default:
      // component・background など：枠を灰色の四角にする
      return { ...base, type: "shape", shape: "rect", fill: GUIDE_GRAY, visible: layer.visible };
  }
}

/** 下書きに残すか：表示されていて、うっすらでなく、対象の矩形に重なる */
function coversTarget(l: Layer, target: Rect): boolean {
  if (l.type === "background" || l.visible === false) return false;
  if ((l.opacity ?? 1) < MIN_OPACITY) return false;
  return overlaps(boundsOf(l), target);
}

export type GuidePlan = {
  /** 下書きを描くための spec（白背景＋前面レイヤーの灰色。対象の画像は含まない） */
  spec: PosterSpec;
  /** 切り抜く範囲（紙面の座標） */
  rect: Rect;
};

/**
 * 下書きの設計：対象レイヤーより前面にあり、その矩形に重なるレイヤーだけを灰色にした spec と、切り抜く矩形。
 * ガイドが要らない（前面に何も重ならない・透過の切り抜き素材・小さい・対象が見つからない）ときは undefined。
 */
export function planLayoutGuide(spec: PosterSpec, layerId: string): GuidePlan | undefined {
  const idx = spec.layers.findIndex((l) => l.id === layerId);
  if (idx < 0) return;
  const target = spec.layers[idx];
  const asset = layerAsset(target);
  if (!asset || asset.transparent) return;
  const { width, height } = spec.meta;
  if ((target.w * target.h) / (width * height) < MIN_COVERAGE) return;
  const rect = clampToPoster(boundsOf(target), width, height);
  if (rect.w < 1 || rect.h < 1) return;
  const front = spec.layers.slice(idx + 1).filter((l) => coversTarget(l, rect));
  if (!front.length) return;
  const bg: Layer = { id: "guide-bg", type: "background", fill: GUIDE_BG, x: 0, y: 0, w: width, h: height };
  return {
    spec: { ...spec, notes: undefined, transition: undefined, bgm: undefined, layers: [bg, ...front.map(grayOut)] },
    rect,
  };
}

/** 下書きを描くときの倍率（切り抜きの長辺が MAX_GUIDE_PX 程度になるように。拡大はしない） */
export const guideScale = (rect: Rect) => Math.min(1, MAX_GUIDE_PX / Math.max(rect.w, rect.h));

/**
 * 画像生成に渡す下書き（PNG の base64）を作る。ブラウザ専用。
 * ガイドが要らないとき、また描けなかったときは undefined（その場合は下書き無しで生成する）。
 */
export async function buildLayoutGuide(spec: PosterSpec, layerId: string): Promise<{ mediaType: string; data: string } | undefined> {
  const plan = planLayoutGuide(spec, layerId);
  if (!plan) return;
  try {
    // svg.ts は DOM を使うので、純粋関数だけをテストで読めるよう使うときに読み込む
    const { renderSpecPng } = await import("../render/svg");
    const scale = guideScale(plan.rect);
    const bitmap = await createImageBitmap(await renderSpecPng(plan.spec, scale));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(plan.rect.w * scale));
    canvas.height = Math.max(1, Math.round(plan.rect.h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = GUIDE_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, plan.rect.x * scale, plan.rect.y * scale, plan.rect.w * scale, plan.rect.h * scale, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return { mediaType: "image/png", data: canvas.toDataURL("image/png").split(",")[1] };
  } catch (e) {
    console.warn("配置の下書きを作れませんでした（下書き無しで生成します）", e);
  }
}
