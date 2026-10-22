import type { ReactNode } from "react";
import type { Paint } from "../schema";
import { resolvePaint, type Theme } from "../themes";

/** Paint を SVG の fill 値と、必要なら <defs> 内のグラデーション要素に変換する */
export function paintToSvg(paint: Paint | undefined, theme: Theme, id: string): { fill: string; def: ReactNode } {
  const p = resolvePaint(paint, theme);
  if (p === undefined) return { fill: "none", def: null };
  if (typeof p === "string") return { fill: p, def: null };
  const stops = p.stops.map((s, i) => <stop key={i} offset={s.offset} stopColor={s.color} />);
  if (p.type === "linear") {
    const rad = ((p.angle ?? 90) * Math.PI) / 180;
    const dx = Math.cos(rad) / 2;
    const dy = Math.sin(rad) / 2;
    return {
      fill: `url(#${id})`,
      def: (
        <linearGradient id={id} x1={0.5 - dx} y1={0.5 - dy} x2={0.5 + dx} y2={0.5 + dy}>
          {stops}
        </linearGradient>
      ),
    };
  }
  return {
    fill: `url(#${id})`,
    def: (
      <radialGradient id={id} cx={p.cx ?? 0.5} cy={p.cy ?? 0.5} r={p.r ?? 0.7}>
        {stops}
      </radialGradient>
    ),
  };
}

/** 決定的な擬似乱数（blob 形状や星の配置用） */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** なめらかな有機的 blob の path を生成（0..w, 0..h） */
export function blobPath(w: number, h: number, seed = 1, points = 7): string {
  const r = rng(seed);
  const pts: [number, number][] = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const k = 0.72 + r() * 0.28;
    pts.push([w / 2 + Math.cos(a) * (w / 2) * k, h / 2 + Math.sin(a) * (h / 2) * k]);
  }
  // Catmull-Rom → Bezier
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < points; i++) {
    const p0 = pts[(i - 1 + points) % points];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % points];
    const p3 = pts[(i + 2) % points];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  return d + "Z";
}
