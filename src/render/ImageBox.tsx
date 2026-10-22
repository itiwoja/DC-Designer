import type { AssetRequest, ImageCrop, Layer } from "../schema";

export const CROP_MAX_SCALE = 5;

/**
 * 拡大率 1 のとき、画像が枠の何倍の幅・高さで描かれるか（枠いっぱいに収めたときのはみ出し分）。
 * ratio（画像の幅/高さ）が分からなければ枠と同じ比率として扱う（＝はみ出しなし）。
 */
function coverK(w: number, h: number, ratio?: number) {
  if (!ratio || !(w > 0) || !(h > 0)) return { kx: 1, ky: 1 };
  const fa = w / h;
  return ratio > fa ? { kx: ratio / fa, ky: 1 } : { kx: 1, ky: fa / ratio };
}

/**
 * ずらし量を、枠の外に余白が出ない範囲に収める。
 * 画像の縦横比（ratio）が分かっていれば、枠からはみ出している分も上下左右に動かせる。
 */
export function clampCrop(c: ImageCrop, w = 1, h = 1, ratio = c.ratio): ImageCrop {
  const scale = Math.max(1, Math.min(CROP_MAX_SCALE, c.scale));
  const { kx, ky } = coverK(w, h, ratio);
  const cl = (v: number, k: number) => { const lim = (k * scale - 1) / 2; return Math.max(-lim, Math.min(lim, v)); };
  return { scale, x: cl(c.x, kx), y: cl(c.y, ky), ...(ratio ? { ratio } : {}) };
}

/** 拡大率・ずらし量の上限（スライダーの範囲用） */
export function cropLimits(w: number, h: number, scale: number, ratio?: number) {
  const { kx, ky } = coverK(w, h, ratio);
  return { x: Math.max(0, (kx * scale - 1) / 2), y: Math.max(0, (ky * scale - 1) / 2) };
}

/** 枠いっぱいに画像を描くので、枠内トリミングできるコンポーネント（crop は props.crop に持つ） */
const CROPPABLE_COMPONENTS = new Set(["circlePhoto", "roundPhoto"]);

/** 角丸写真の角の丸み（px）。props.radius は短い辺に対する割合 */
export function roundPhotoRadius(p: { radius?: unknown }, w: number, h: number) {
  const k = p.radius == null || p.radius === "" ? 0.2 : Number(p.radius);
  return Math.min(w, h) * Math.max(0, Math.min(0.5, Number.isFinite(k) ? k : 0.2));
}

/** 枠内でトリミング（拡大・位置調整）できる画像を持つレイヤーなら、その画像の情報を返す（radius は枠の角の丸み px） */
export function cropTarget(l: Layer | null | undefined): { src: string; crop?: ImageCrop; fit: "cover" | "contain"; ellipse: boolean; radius?: number } | null {
  if (!l || l.locked) return null;
  if (l.type === "image" && l.src) return { src: l.src, crop: l.crop, fit: l.fit ?? "contain", ellipse: false };
  if (l.type === "component" && CROPPABLE_COMPONENTS.has(l.component) && typeof l.props?.src === "string" && l.props.src) {
    const round = l.component === "roundPhoto";
    return { src: l.props.src, crop: l.props.crop, fit: "cover", ellipse: !round, radius: round ? roundPhotoRadius(l.props, l.w, l.h) : undefined };
  }
  return null;
}

/** crop を差し替えたレイヤーを返す（拡大なし・ずらしなしなら crop 自体を消す） */
export function withCrop<T extends Layer>(l: T, crop: ImageCrop | undefined): T {
  const c = crop && (crop.scale !== 1 || crop.x || crop.y) ? crop : undefined;
  if (l.type === "component") {
    const props = { ...l.props };
    if (c) props.crop = c; else delete props.crop;
    return { ...l, props };
  }
  const n = { ...l } as any;
  if (c) n.crop = c; else delete n.crop;
  return n;
}

/**
 * 枠 (0,0,w,h) に対する、トリミング後の画像の描画矩形。
 * crop.ratio があれば画像本来の縦横比で描く（contain のときは枠の比率のまま）。
 */
export function cropRect(w: number, h: number, crop?: ImageCrop, fit: "cover" | "contain" = "cover") {
  const c = crop ? clampCrop(fit === "cover" ? crop : { ...crop, ratio: undefined }, w, h) : { scale: 1, x: 0, y: 0 };
  const { kx, ky } = coverK(w, h, c.ratio);
  const rw = w * kx * c.scale, rh = h * ky * c.scale;
  return { x: (w - rw) / 2 + c.x * w, y: (h - rh) / 2 + c.y * h, w: rw, h: rh };
}

/** 画像（src が無ければ「生成待ち」プレースホルダー）を (0,0,w,h) に描画。ellipse なら丸く切り抜く */
export function ImageBox({
  id, src, asset, w, h, fit = "cover", crop, radius = 0, blur, ellipse,
}: {
  id: string; src?: string; asset?: AssetRequest; w: number; h: number; fit?: "cover" | "contain"; crop?: ImageCrop; radius?: number; blur?: number; ellipse?: boolean;
}) {
  const clipId = `${id}-clip`;
  const blurId = `${id}-blur`;
  // 枠の形（角丸の rect か、枠いっぱいの楕円）
  const frame = (extra: Record<string, unknown> = {}) =>
    ellipse ? <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...extra} /> : <rect width={w} height={h} rx={radius} {...extra} />;
  if (!src) {
    return (
      <g>
        <defs>
          <pattern id={`${id}-hatch`} width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="16" height="16" fill="#eceaf4" />
            <rect width="8" height="16" fill="#e2dfee" />
          </pattern>
        </defs>
        {frame({ fill: `url(#${id}-hatch)`, stroke: "#b9b3d1", strokeDasharray: "8 6", strokeWidth: 2 })}
        {/* 楕円は内接する矩形に文字を収める */}
        <foreignObject
          x={ellipse ? w * 0.15 : 8} y={ellipse ? h * 0.15 : 8}
          width={Math.max(0, ellipse ? w * 0.7 : w - 16)} height={Math.max(0, ellipse ? h * 0.7 : h - 16)}
          data-export-skip="true"
        >
          <div
            style={{
              width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
              textAlign: "center", font: `600 ${Math.max(11, Math.min(18, w / 18))}px sans-serif`, color: "#6b6390", overflow: "hidden",
            }}
          >
            🖼 {asset?.prompt || "画像未設定"}
          </div>
        </foreignObject>
      </g>
    );
  }
  const r = cropRect(w, h, crop, fit);
  return (
    <g>
      <defs>
        <clipPath id={clipId}>{frame()}</clipPath>
        {blur ? (
          <filter id={blurId} x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation={blur} />
          </filter>
        ) : null}
      </defs>
      <image
        href={src}
        x={r.x} y={r.y} width={r.w} height={r.h}
        preserveAspectRatio={fit === "cover" ? "xMidYMid slice" : "xMidYMid meet"}
        clipPath={ellipse || radius || fit === "cover" || (crop && crop.scale > 1) ? `url(#${clipId})` : undefined}
        filter={blur ? `url(#${blurId})` : undefined}
      />
    </g>
  );
}
