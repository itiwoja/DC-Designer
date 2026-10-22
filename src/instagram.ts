import { PosterSpecSchema, type Layer, type PosterSpec } from "./schema";

/**
 * Instagram 投稿モード。1 投稿 = 画像 1〜20 枚（カルーセル）で、全枚が同じ比率になる（Instagram は 1 枚目の比率にそろえる）。
 * 座標は書き出しの実寸（幅 1080px）そのまま
 */
export const IG_RATIOS = {
  "1:1": { label: "正方形 1:1", w: 1080, h: 1080, note: "フィードの定番" },
  "4:5": { label: "縦長 4:5", w: 1080, h: 1350, note: "フィードで一番大きく表示される" },
  "3:4": { label: "縦長 3:4", w: 1080, h: 1440, note: "プロフィールの一覧と同じ比率" },
  "9:16": { label: "縦長 9:16", w: 1080, h: 1920, note: "ストーリーズ・リール" },
  "1.91:1": { label: "横長 1.91:1", w: 1080, h: 566, note: "横長の写真向け" },
} as const;
export type IgRatio = keyof typeof IG_RATIOS;
export const IG_RATIO_KEYS = Object.keys(IG_RATIOS) as IgRatio[];
export const IG_DEFAULT_RATIO: IgRatio = "4:5";
/** カルーセルに入れられる最大枚数 */
export const IG_MAX_IMAGES = 20;

/** キャンバスの大きさに一番近い比率（どれとも 2% 以上ずれていれば undefined） */
export function ratioOf(w: number, h: number): IgRatio | undefined {
  return IG_RATIO_KEYS.find((k) => Math.abs(IG_RATIOS[k].w / IG_RATIOS[k].h - w / h) < 0.02 * (w / h));
}

export function blankInstagramSpec(ratio: IgRatio, title = "投稿 1"): PosterSpec {
  const { w, h } = IG_RATIOS[ratio];
  return PosterSpecSchema.parse({
    version: 1,
    meta: { title, width: w, height: h },
    theme: "ocean",
    layers: [{ id: "bg", name: "背景", type: "background", fill: "$background", x: 0, y: 0, w, h }],
  });
}

const round = (v: number) => Math.round(v * 10) / 10;

/** レイヤーの中身（文字の大きさ・線の太さ・角丸・影など）を k 倍する。子レイヤーは座標ごと k 倍 */
function scaleContent(l: Layer, k: number): Layer {
  if (k === 1) return l;
  const out: any = { ...l };
  const mul = (key: string) => { if (typeof out[key] === "number") out[key] = round(out[key] * k); };
  if (out.shadow) out.shadow = { ...out.shadow, dx: round(out.shadow.dx * k), dy: round(out.shadow.dy * k), blur: round(out.shadow.blur * k) };
  if (l.type === "text") {
    mul("size");
    if (l.outlines) out.outlines = l.outlines.map((o) => ({ ...o, width: round(o.width * k) }));
  }
  if (l.type === "shape") { mul("strokeWidth"); mul("radius"); mul("blur"); }
  if (l.type === "image") { mul("radius"); mul("blur"); }
  if (l.type === "group") {
    out.children = l.children.map((c) => scaleContent({ ...c, x: round(c.x * k), y: round(c.y * k), w: round(c.w * k), h: round(c.h * k) } as Layer, k));
  }
  return out;
}

/**
 * キャンバスの大きさを変えて、レイヤーを並べ直す（Instagram の比率の切り替え）。
 * - 背景と、キャンバス全面を覆うレイヤー（全面写真など）は新しいキャンバスいっぱいに伸ばす
 * - ほかは中心の位置を縦横の比で移し、大きさは縮む向きの比（はみ出さないよう、大きくはしない）で拡大縮小する
 */
export function resizeCanvas(spec: PosterSpec, width: number, height: number): PosterSpec {
  const { width: W, height: H } = spec.meta;
  if (W === width && H === height) return spec;
  const sx = width / W, sy = height / H;
  const k = Math.min(1, sx, sy);
  const layers = spec.layers.map((l): Layer => {
    const fullBleed = l.type === "background" || (l.x <= W * 0.02 && l.y <= H * 0.02 && l.x + l.w >= W * 0.98 && l.y + l.h >= H * 0.98 && !l.rotation);
    if (fullBleed) return { ...l, x: round(l.x * sx), y: round(l.y * sy), w: round(l.w * sx), h: round(l.h * sy) } as Layer;
    const w = round(l.w * k), h = round(l.h * k);
    const cx = (l.x + l.w / 2) * sx, cy = (l.y + l.h / 2) * sy;
    return scaleContent({ ...l, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h } as Layer, k);
  });
  return { ...spec, meta: { ...spec.meta, width, height }, layers };
}

/** 画像の縦横比に一番近い比率（ChatGPT の 2:3 なら 3:4 のように、ずれていても必ずどれかを返す） */
export function nearestRatio(w: number, h: number): IgRatio {
  const d = (k: IgRatio) => Math.abs(Math.log(IG_RATIOS[k].w / IG_RATIOS[k].h) - Math.log(w / h));
  return IG_RATIO_KEYS.reduce((a, b) => (d(b) < d(a) ? b : a));
}
