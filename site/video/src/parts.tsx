import type { CSSProperties, ReactNode } from "react";
import { Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT_BODY, FONT_DISPLAY } from "./theme";

export const ease = Easing.bezier(0.16, 1, 0.3, 1);

/** 0→1 を from〜to フレームで（範囲外は止める） */
export const prog = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * スクショ（natural の大きさ）の一部 rect を、画面の box にぴったり収めて見せるカメラ。
 * rects と at（フレーム）を渡すと、その間を滑らかに動く。
 */
export function Camera({ src, natural, box, rects, at, radius = 18, shadow = true, children }: {
  src: string;
  natural: { w: number; h: number };
  box: Rect;
  rects: Rect[];
  at: number[];
  radius?: number;
  shadow?: boolean;
  /** スクショの座標（natural の px）で重ねて描くもの */
  children?: ReactNode;
}) {
  const frame = useCurrentFrame();
  const t = (k: keyof Rect) =>
    rects.length === 1 ? rects[0][k] : interpolate(frame, at, rects.map((r) => r[k]), { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const r = { x: t("x"), y: t("y"), w: t("w"), h: t("h") };
  const s = Math.max(box.w / r.w, box.h / r.h);
  return (
    <div
      style={{
        position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, overflow: "hidden", borderRadius: radius,
        boxShadow: shadow ? "0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08)" : undefined, background: "#f3f3f5",
      }}
    >
      <div
        style={{
          position: "absolute", left: 0, top: 0, width: natural.w, height: natural.h, transformOrigin: "0 0",
          transform: `translate(${-(r.x + r.w / 2) * s + box.w / 2}px, ${-(r.y + r.h / 2) * s + box.h / 2}px) scale(${s})`,
        }}
      >
        <Img src={staticFile(src)} style={{ position: "absolute", left: 0, top: 0, width: natural.w, height: natural.h, maxWidth: "none" }} />
        {children}
      </div>
    </div>
  );
}

/** 跳ねて出る見出し（1 文字ずつ少し遅らせる） */
export function PopText({ text, start, size, color = C.white, style, stagger = 2 }: {
  text: string; start: number; size: number; color?: string; style?: CSSProperties; stagger?: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // 改行（\n）ごとに行を分け、文字の遅れは全体の通し番号で数える
  let n = 0;
  return (
    <div style={{ fontFamily: FONT_DISPLAY, fontSize: size, color, lineHeight: 1.25, letterSpacing: "0.02em", whiteSpace: "pre", fontFeatureSettings: '"palt"', ...style }}>
      {text.split("\n").map((line, li) => (
        <div key={li}>
          {[...line].map((ch) => {
            const i = n++;
            const p = spring({ frame: frame - start - i * stagger, fps, config: { damping: 11, stiffness: 160, mass: 0.6 } });
            return (
              <span key={i} style={{ display: "inline-block", transform: `translateY(${(1 - p) * 0.5 * size}px) scale(${0.6 + 0.4 * p})`, opacity: Math.min(1, p * 1.5) }}>
                {ch === " " ? "\u00a0" : ch}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** 小さな補足（作例であることの注記など） */
export function Note({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ position: "absolute", fontFamily: FONT_BODY, fontWeight: 500, fontSize: 24, color: "rgba(255,255,255,.8)", letterSpacing: "0.04em", ...style }}>
      {children}
    </div>
  );
}

/** ● ▲ ■（サイトの印と同じ形・色） */
export function Shape({ kind, size, color }: { kind: "circle" | "triangle" | "square"; size: number; color: string }) {
  if (kind === "circle") return <div style={{ width: size, height: size, borderRadius: "50%", background: color }} />;
  if (kind === "square") return <div style={{ width: size, height: size, background: color, borderRadius: size * 0.06 }} />;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: "block" }}>
      <polygon points="50,6 96,92 4,92" fill={color} />
    </svg>
  );
}

/** 舞台（墨の地に、ごく弱い光） */
export function Stage({ children }: { children: ReactNode }) {
  return (
    <div style={{ position: "absolute", inset: 0, background: `radial-gradient(120% 90% at 50% 0%, #2a2a33 0%, ${C.ink} 60%)`, overflow: "hidden" }}>
      {children}
    </div>
  );
}

/** 画面に描く丸（操作の場所を示す）。Camera の中ではスクショの座標・大きさで描く */
export function Ring({ x, y, start, size = 68, color = C.yellow }: { x: number; y: number; start: number; size?: number; color?: string }) {
  const frame = useCurrentFrame();
  const p = prog(frame, start, start + 12);
  const fade = 1 - prog(frame, start + 14, start + 26);
  return (
    <div
      style={{
        position: "absolute", left: x - size / 2, top: y - size / 2, width: size, height: size, borderRadius: "50%",
        border: `${size * 0.08}px solid ${color}`, transform: `scale(${0.4 + p * 0.9})`, opacity: p * fade,
      }}
    />
  );
}
