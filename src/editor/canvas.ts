/** キャンバス操作の幾何計算（スナップ・リサイズ・回転）。React 非依存 */

export interface Box { x: number; y: number; w: number; h: number; rotation?: number }
export interface Guide { axis: "x" | "y"; pos: number }

const rad = (deg: number) => (deg * Math.PI) / 180;

/** 回転を考慮した軸平行バウンディングボックス */
export function aabb(b: Box): { x: number; y: number; w: number; h: number } {
  const r = rad(b.rotation ?? 0);
  if (!r) return { x: b.x, y: b.y, w: b.w, h: b.h };
  const cos = Math.abs(Math.cos(r)), sin = Math.abs(Math.sin(r));
  const w = b.w * cos + b.h * sin, h = b.w * sin + b.h * cos;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * 移動中のボックスをキャンバス端・中央、他レイヤーの端・中央へ吸着させる。
 * threshold はポスター座標系での距離（画面上の数px相当を渡す）。
 */
export function snapMove(box: Box, others: Box[], canvas: { w: number; h: number }, threshold: number) {
  const a = aabb(box);
  const xs = [0, canvas.w / 2, canvas.w];
  const ys = [0, canvas.h / 2, canvas.h];
  for (const o of others.map(aabb)) {
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  const pick = (points: number[], cands: number[]) => {
    let best: number | null = null;
    for (const p of points) for (const c of cands) {
      const d = c - p;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
    return best ?? 0;
  };
  const dx = pick([a.x, a.x + a.w / 2, a.x + a.w], xs);
  const dy = pick([a.y, a.y + a.h / 2, a.y + a.h], ys);
  // 吸着後に一致している線をすべてガイドとして返す
  const guides: Guide[] = [];
  const sx = [a.x + dx, a.x + dx + a.w / 2, a.x + dx + a.w];
  const sy = [a.y + dy, a.y + dy + a.h / 2, a.y + dy + a.h];
  for (const c of new Set(xs)) if (sx.some((p) => Math.abs(p - c) < 0.5)) guides.push({ axis: "x", pos: c });
  for (const c of new Set(ys)) if (sy.some((p) => Math.abs(p - c) < 0.5)) guides.push({ axis: "y", pos: c });
  return { dx, dy, guides };
}

/** ハンドルの向き。-1/0/1 の組（例: [1,1] = 右下, [0,-1] = 上辺） */
export type Handle = [number, number];
export const HANDLES: Handle[] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
export const HANDLE_CURSORS: Record<string, string> = {
  "-1,-1": "nwse-resize", "1,1": "nwse-resize", "1,-1": "nesw-resize", "-1,1": "nesw-resize",
  "0,-1": "ns-resize", "0,1": "ns-resize", "-1,0": "ew-resize", "1,0": "ew-resize",
};

/**
 * 回転済みボックスを、反対側のハンドルを固定したままリサイズする。
 * delta はポスター座標系でのポインタ移動量。keepRatio は四隅ハンドルで縦横比を保つ。
 */
export function resizeBox(start: Box, handle: Handle, delta: { x: number; y: number }, keepRatio: boolean): Box {
  const [hx, hy] = handle;
  const r = rad(start.rotation ?? 0);
  const cos = Math.cos(r), sin = Math.sin(r);
  // ローカル座標系での移動量
  const lx = delta.x * cos + delta.y * sin;
  const ly = -delta.x * sin + delta.y * cos;
  let w = hx ? Math.max(8, start.w + hx * lx) : start.w;
  let h = hy ? Math.max(8, start.h + hy * ly) : start.h;
  if (keepRatio && hx && hy) {
    const k = Math.max(w / start.w, h / start.h);
    w = start.w * k;
    h = start.h * k;
  }
  // 固定点（反対側ハンドル）のワールド座標を保つように中心を求め直す
  const rot = (x: number, y: number) => [x * cos - y * sin, x * sin + y * cos];
  const [ax, ay] = rot((-hx * start.w) / 2, (-hy * start.h) / 2);
  const anchor = [start.x + start.w / 2 + ax, start.y + start.h / 2 + ay];
  const [bx, by] = rot((-hx * w) / 2, (-hy * h) / 2);
  const cx = anchor[0] - bx, cy = anchor[1] - by;
  return { ...start, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.round(w), h: Math.round(h) };
}

/** 中心からポインタへの角度（上向き = 0°）。step15 なら 15° 刻み、それ以外も 0/90/180/270 付近は吸着 */
export function angleFrom(center: { x: number; y: number }, p: { x: number; y: number }, step15: boolean) {
  let deg = (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI + 90;
  deg = ((deg % 360) + 360) % 360;
  if (step15) return (Math.round(deg / 15) * 15) % 360;
  const near = Math.round(deg / 90) * 90;
  if (Math.abs(deg - near) < 3) return near % 360;
  return Math.round(deg);
}

/** 複数ボックスをまとめて囲む矩形（各ボックスは回転を考慮） */
export function unionBox(boxes: Box[]): { x: number; y: number; w: number; h: number } {
  const bs = boxes.map(aabb);
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  const r = Math.max(...bs.map((b) => b.x + b.w)), btm = Math.max(...bs.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: btm - y };
}

/** 2 つの軸平行矩形が重なるか（範囲選択の当たり判定） */
export function intersects(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
