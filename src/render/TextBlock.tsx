import { useLayoutEffect, useRef, useState } from "react";
import type { Paint } from "../schema";
import { resolveColor, resolveFont, type Theme } from "../themes";
import { paintToSvg } from "./paint";
import { lineSegments, type ColorRun } from "../textRuns";

export interface TextBlockProps {
  id: string;
  text: string;
  w: number;
  h: number;
  theme: Theme;
  font?: string;
  size?: number;
  weight?: number;
  lineHeight?: number;
  letterSpacing?: number;
  align?: "left" | "center" | "right";
  fill?: Paint;
  /** 一部の文字だけの色（縁取りには効かない） */
  colorRuns?: ColorRun[];
  outlines?: { color: string; width: number }[];
  skewX?: number;
  fit?: "none" | "shrink";
}

/**
 * 複数行テキスト。outlines は外側から順に太い縁取りを重ねる（ステッカー風タイトル用）。
 * fit="shrink" のとき、描画後に実寸を測って枠 (w,h) に収まるよう縮小する。
 */
export function TextBlock(p: TextBlockProps) {
  const size = p.size ?? 32;
  const lh = p.lineHeight ?? 1.25;
  const align = p.align ?? "left";
  const lines = p.text.split("\n");
  const anchor: "start" | "middle" | "end" = align === "center" ? "middle" : align === "right" ? "end" : "start";
  // 揃えの基準になる x（縮小もここを中心に行う）
  const ax = align === "center" ? p.w / 2 : align === "right" ? p.w : 0;
  const { fill, def } = paintToSvg(p.fill ?? "$ink", p.theme, `${p.id}-fill`);
  const fontFamily = resolveFont(p.font, p.theme, p.weight ?? 700);

  const ref = useRef<SVGGElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    if (p.fit !== "shrink" || !ref.current) return setScale(1);
    const measure = () => {
      if (!ref.current) return; // 書き出し用の画面外描画などで、フォント読み込み待ちの間に外された
      const bb = ref.current.getBBox();
      if (!bb.width || !bb.height) return;
      setScale(Math.min(1, p.w / bb.width, p.h / bb.height));
    };
    measure();
    // 発表者ビューのような別ウィンドウに描くときは、そのウィンドウのフォントの読み込みを待つ
    const fonts = ref.current.ownerDocument.fonts;
    fonts?.ready.then(measure);
    // あとから読み込まれた Web フォント（フォント変更直後など）でも測り直す
    fonts?.addEventListener("loadingdone", measure);
    return () => fonts?.removeEventListener("loadingdone", measure);
  }, [p.text, p.w, p.h, size, fontFamily, p.weight, p.letterSpacing, lh, p.fit]);

  const tspans = (key: string, segments?: ReturnType<typeof lineSegments>) =>
    lines.map((line, i) => (
      <tspan key={key + i} x={ax} dy={i === 0 ? size * 0.88 : size * lh}>
        {segments
          ? segments[i].map((s, j) => (s.color ? <tspan key={j} fill={resolveColor(s.color, p.theme)}>{s.text}</tspan> : s.text))
          : line}
      </tspan>
    ));

  const common = {
    fontFamily,
    fontSize: size,
    fontWeight: p.weight ?? 700,
    textAnchor: anchor,
    letterSpacing: p.letterSpacing ? `${p.letterSpacing}em` : undefined,
    style: { whiteSpace: "pre" as const },
  };

  const transform = [
    scale !== 1 ? `translate(${ax * (1 - scale)} 0) scale(${scale})` : "",
    p.skewX ? `skewX(${p.skewX})` : "",
  ].join(" ").trim() || undefined;

  return (
    <g transform={transform} data-text-block="" data-fit-scale={scale}>
      {def && <defs>{def}</defs>}
      <g ref={ref}>
        {(p.outlines ?? []).map((o, i) => (
          <text
            key={"o" + i}
            {...common}
            fill={resolveColor(o.color, p.theme)}
            stroke={resolveColor(o.color, p.theme)}
            strokeWidth={o.width * 2}
            strokeLinejoin="round"
            strokeLinecap="round"
          >
            {tspans("o" + i)}
          </text>
        ))}
        <text {...common} fill={fill}>
          {tspans("t", p.colorRuns?.length ? lineSegments(p.text, p.colorRuns) : undefined)}
        </text>
      </g>
    </g>
  );
}
