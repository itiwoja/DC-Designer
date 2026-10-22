/** エディタで使う spec / レイヤーの純粋な操作（React 非依存） */
import type { AssetContext, AssetRequest, Layer, PosterSpec } from "../schema";
import { resolveTheme } from "../themes";
import { aabb, unionBox, type Handle } from "./canvas";

/** 選択全体を反対側の角を固定して等倍に拡縮する。開始時のレイヤーから毎回計算する。 */
export function resizeSelection(layers: Layer[], handle: Handle, delta: { x: number; y: number }): Layer[] {
  const targets = layers.filter((l) => !l.locked && l.type !== "background");
  if (!targets.length) return [];
  const b = unionBox(targets);
  if (b.w <= 0 || b.h <= 0) return targets;
  const [hx, hy] = handle;
  const vx = hx * b.w, vy = hy * b.h;
  const ratio = Math.max(8 / Math.min(b.w, b.h), 1 + (delta.x * vx + delta.y * vy) / (vx * vx + vy * vy));
  const ax = b.x + (1 - hx) * b.w / 2, ay = b.y + (1 - hy) * b.h / 2;
  const scale = (l: Layer, ox: number, oy: number): Layer => {
    const next = { ...l, x: ox + (l.x - ox) * ratio, y: oy + (l.y - oy) * ratio, w: l.w * ratio, h: l.h * ratio };
    if (next.shadow) next.shadow = { ...next.shadow, dx: (next.shadow.dx ?? 0) * ratio, dy: (next.shadow.dy ?? 4) * ratio, blur: (next.shadow.blur ?? 6) * ratio };
    if (next.type === "text") {
      next.size *= ratio;
      if (next.outlines) next.outlines = next.outlines.map((o) => ({ ...o, width: o.width * ratio }));
    }
    if (next.type === "shape" && next.strokeWidth !== undefined) next.strokeWidth *= ratio;
    if (next.type === "shape" || next.type === "image") {
      if (next.radius !== undefined) next.radius *= ratio;
      if (next.blur !== undefined) next.blur *= ratio;
    }
    if (next.type === "group") next.children = next.children.map((c) => scale(c, 0, 0));
    return next;
  };
  return targets.map((l) => scale(l, ax, ay));
}

export const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 7)}`;

export const aspectOf = (w: number, h: number): AssetRequest["aspect"] => (w / h > 1.2 ? "landscape" : w / h < 0.83 ? "portrait" : "square");

/** ファイル名に使えない文字を置き換える */
export const safeFileName = (name: string, fallback = "poster") => (name || fallback).replace(/[\\/:*?"<>|]/g, "_");

/** キャンバスに見えている前景のレイヤーか（背景・非表示・別テーマ専用を除く） */
export const isVisibleOnCanvas = (l: Layer, theme: string) => l.type !== "background" && l.visible !== false && (!l.themes || l.themes.includes(theme));

/** layers の afterId の 1 つ上（見つからなければ最前面）に items を差し込む */
export function insertAfter(layers: Layer[], afterId: string | undefined, items: Layer[]): Layer[] {
  const next = [...layers];
  const i = afterId ? next.findIndex((l) => l.id === afterId) : -1;
  next.splice(i < 0 ? next.length : i + 1, 0, ...items);
  return next;
}

/** id のレイヤーを to が返す位置へ動かす（背景レイヤー（先頭）より後ろには回さない）。変化が無ければ同じ配列を返す */
export function reorderLayer(layers: Layer[], id: string, to: (layers: Layer[], i: number) => number): Layer[] {
  const i = layers.findIndex((l) => l.id === id);
  if (i < 0) return layers;
  const lo = layers[0]?.type === "background" && layers[0].id !== id ? 1 : 0;
  const j = Math.max(lo, Math.min(layers.length - 1, to(layers, i)));
  if (i === j) return layers;
  const next = [...layers];
  const [l] = next.splice(i, 1);
  next.splice(j, 0, l);
  return next;
}

/** id のレイヤーを targetId の上（above）か下へ移す。どちらかが無ければ同じ配列を返す */
export function moveLayerTo(layers: Layer[], id: string, targetId: string, above: boolean): Layer[] {
  const rest = layers.filter((l) => l.id !== id);
  const moving = layers.find((l) => l.id === id);
  const t = rest.findIndex((l) => l.id === targetId);
  if (!moving || t < 0) return layers;
  rest.splice(above ? t + 1 : t, 0, moving);
  return rest;
}

export type AlignTo = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
/** ポスター（W×H）の端・中央に揃える位置。回転時は見た目の外接矩形で揃える */
export function alignedPosition(l: Layer, where: AlignTo, W: number, H: number): { x: number } | { y: number } {
  const b = aabb(l);
  const ox = l.x - b.x, oy = l.y - b.y;
  return {
    left: { x: ox }, hcenter: { x: Math.round((W - b.w) / 2 + ox) }, right: { x: Math.round(W - b.w + ox) },
    top: { y: oy }, vcenter: { y: Math.round((H - b.h) / 2 + oy) }, bottom: { y: Math.round(H - b.h + oy) },
  }[where];
}

// ---------- 画像 ----------
export const IMAGE_FILE_TYPES = /^image\/(png|jpeg|webp|gif)$/;
export const IMAGE_FILE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export const PPTX_ACCEPT = ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** 画像の格納先: レイヤーID ＋ レイヤー内のパス（image レイヤーなら []、コンポーネントなら ["props"]） */
export type LayerRef = { layerId: string; rest: (string | number)[] };

/** 画像生成プロンプト（asset）を持つレイヤーなら、その asset と格納先を返す */
export function assetHolder(layer: Layer | null): { asset: AssetRequest; rest: (string | number)[] } | null {
  if (layer?.type === "image" && layer.asset) return { asset: layer.asset, rest: [] };
  if (layer?.type === "component" && (layer.props as any)?.asset) return { asset: (layer.props as any).asset, rest: ["props"] };
  return null;
}

/** 画像ファイルで差し替えられるレイヤーなら、src の格納先を返す（image レイヤー / 画像を持つコンポーネント） */
export function imageSlot(layer: Layer | null): { rest: (string | number)[] } | null {
  if (layer?.type === "image") return { rest: [] };
  if (layer?.type === "component" && layer.props && ("asset" in layer.props || "src" in layer.props)) return { rest: ["props"] };
  return null;
}

/** パス ["layers", i, ...rest] をレイヤーID基準に変換（生成中にレイヤー順が変わっても追従できるように） */
export function toLayerRef(spec: PosterSpec, path: (string | number)[]): LayerRef {
  return { layerId: spec.layers[path[1] as number].id, rest: path.slice(2) };
}

/** ref の位置の画像 src を差し替える（undefined なら外す） */
export function patchAsset(spec: PosterSpec, ref: LayerRef, src: string | undefined): PosterSpec {
  const idx = spec.layers.findIndex((l) => l.id === ref.layerId);
  if (idx < 0) return spec;
  const layer = structuredClone(spec.layers[idx]) as any;
  let node = layer;
  for (const k of ref.rest) node = node?.[k];
  if (!node) return spec;
  if (src === undefined) delete node.src;
  else node.src = src;
  // 画像が変わったら縦横比は測り直す（残すと新しい画像で枠に余白が出ることがある）
  if (node.crop?.ratio) { node.crop = { ...node.crop }; delete node.crop.ratio; }
  const layers = [...spec.layers];
  layers[idx] = layer;
  return { ...spec, layers };
}

/**
 * 画像をポスターになじませる準備。
 * - image レイヤーは枠の縦横比に合わせて aspect を補正（AI の指定ミスで cover 時に大きく切れないように）
 * - ポスター共通の画風・配色・置かれる大きさ（主役/添え/挿絵）・入れ物のコンポーネントを文脈として渡す
 */
export function prepareAsset(spec: PosterSpec, ref: LayerRef, asset: AssetRequest): { asset: AssetRequest; context: AssetContext } {
  const t = resolveTheme(spec.theme, spec.themeOverride);
  const c = t.colors;
  const context: AssetContext = {
    style: spec.meta.imageStyle || t.imageStyle,
    palette: [c.primary, c.secondary, c.accent, c.bg].filter((v) => v && !v.startsWith("$")),
  };
  const layer = spec.layers.find((l) => l.id === ref.layerId);
  if (!layer || layer.type === "background") return { asset, context };
  const coverage = (layer.w * layer.h) / (spec.meta.width * spec.meta.height);
  context.role = coverage >= 0.18 ? "hero" : coverage >= 0.05 ? "supporting" : "small";
  if (layer.type === "component") context.component = layer.component;
  if (layer.type === "image" && ref.rest.length === 0) asset = { ...asset, aspect: aspectOf(layer.w, layer.h) };
  return { asset, context };
}

export const naturalSize = (src: string) => new Promise<{ w: number; h: number }>((res) => {
  const img = new Image();
  img.onload = () => res({ w: img.naturalWidth || 400, h: img.naturalHeight || 400 });
  img.onerror = () => res({ w: 400, h: 400 });
  img.src = src;
});

// ---------- AI の変更 ----------
/** AI による変更前後の差分（レイヤー単位） */
export function diffLayers(before: PosterSpec, after: PosterSpec) {
  const prev = new Map(before.layers.map((l) => [l.id, JSON.stringify(l)]));
  const next = new Set(after.layers.map((l) => l.id));
  const added: string[] = [], changed: string[] = [];
  for (const l of after.layers) {
    const p = prev.get(l.id);
    if (p === undefined) added.push(l.id);
    else if (p !== JSON.stringify(l)) changed.push(l.id);
  }
  const removed = before.layers.filter((l) => !next.has(l.id)).length;
  // テーマ名かテーマの上書き（色・フォント等）が変わったか
  const themeChanged = before.theme !== after.theme || JSON.stringify(before.themeOverride) !== JSON.stringify(after.themeOverride);
  // ポスター設定（タイトル・サイズ・画風）が変わったか
  const metaChanged = JSON.stringify(before.meta) !== JSON.stringify(after.meta);
  // 台本（スライドのノート）が変わったか
  const notesChanged = (before.notes ?? "") !== (after.notes ?? "");
  // 画面切り替えが変わったか
  const transitionChanged = JSON.stringify(before.transition) !== JSON.stringify(after.transition);
  // 共通のレイヤーの並び（z-order）が変わったか
  const inAfter = new Set(after.layers.map((l) => l.id)), inBefore = new Set(before.layers.map((l) => l.id));
  const oldOrder = before.layers.map((l) => l.id).filter((id) => inAfter.has(id));
  const newOrder = after.layers.map((l) => l.id).filter((id) => inBefore.has(id));
  const reordered = oldOrder.some((id, i) => id !== newOrder[i]);
  // 適用するかの判定は spec 全体で行う（上の項目以外が変わっても取りこぼさない）
  const hasChanges = JSON.stringify(before) !== JSON.stringify(after);
  return { added, changed, removed, themeChanged, metaChanged, notesChanged, transitionChanged, reordered, hasChanges };
}
