import type { ReactNode } from "react";
import QRCode from "qrcode";
import { resolveColor, type Theme } from "../themes";
import { TextBlock } from "../render/TextBlock";
import { ImageBox, roundPhotoRadius } from "../render/ImageBox";
import { paintToSvg, rng } from "../render/paint";
import { Icon } from "./icons";

/** 描画先のレイヤー情報（id は defs の id の接頭辞に使う） */
interface Ctx {
  id: string;
  w: number;
  h: number;
  theme: Theme;
}
type Render = (props: Record<string, any>, ctx: Ctx) => ReactNode;

/** props の色（"$token" か CSS カラー）を解決する。未指定なら fallback */
const c = (v: string | undefined, theme: Theme, fallback: string) => resolveColor(v ?? fallback, theme);

type TextAlign = "left" | "center" | "right";
/**
 * コンポーネント内テキストの位置調整（共通 props）。
 * textDx / textDy: 既定位置からのずらし量(px)、textAlign: 文字揃え。
 * prefix="label" なら labelDx / labelDy / labelAlign を読む（QR の見出しなど）。
 */
function textPos(p: Record<string, any>, def: TextAlign, prefix = "text") {
  const align: TextAlign = ["left", "center", "right"].includes(p[`${prefix}Align`]) ? p[`${prefix}Align`] : def;
  return { dx: Number(p[`${prefix}Dx`]) || 0, dy: Number(p[`${prefix}Dy`]) || 0, align };
}

/** 4 方向に尖ったキラキラの輪郭 */
const sparklePath = (w: number, h: number) =>
  `M${w / 2} 0 C${w * 0.54} ${h * 0.36} ${w * 0.64} ${h * 0.46} ${w} ${h / 2} C${w * 0.64} ${h * 0.54} ${w * 0.54} ${h * 0.64} ${w / 2} ${h} C${w * 0.46} ${h * 0.64} ${w * 0.36} ${h * 0.54} 0 ${h / 2} C${w * 0.36} ${h * 0.46} ${w * 0.46} ${h * 0.36} ${w / 2} 0Z`;

function Glow({ id, color, std = 6 }: { id: string; color: string; std?: number }) {
  return (
    <filter id={id} x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="0" stdDeviation={std} floodColor={color} floodOpacity="0.8" />
    </filter>
  );
}

/** 紙・端末の落ち影。region は filter 領域 [x, y, width, height] */
function DropShadow({ id, dx = 0, dy, std, opacity, region }: { id: string; dx?: number; dy: number; std: number; opacity: number; region: [string, string, string, string] }) {
  const [x, y, width, height] = region;
  return (
    <filter id={id} x={x} y={y} width={width} height={height}>
      <feDropShadow dx={dx} dy={dy} stdDeviation={std} floodOpacity={opacity} />
    </filter>
  );
}

function Tape({ x, y, w, h, rotate, color }: { x: number; y: number; w: number; h: number; rotate: number; color: string }) {
  const r = rng(Math.round(x + y + w));
  const jag = (side: number) =>
    Array.from({ length: 5 }, (_, i) => `${side + (r() - 0.5) * h * 0.25},${(i / 4) * h}`).join(" L");
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate} ${w / 2} ${h / 2})`}>
      <path d={`M${jag(0)} L${jag(w).split(" L").reverse().join(" L")}Z`} fill={color} opacity={0.82} />
    </g>
  );
}

/** もこもこ雲の輪郭 */
function cloudPath(w: number, h: number, bumps = 11) {
  const cx = w / 2, cy = h / 2, rx = w * 0.43, ry = h * 0.4;
  const pts = Array.from({ length: bumps }, (_, i) => {
    const a = (i / bumps) * Math.PI * 2 - Math.PI / 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
  });
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i <= bumps; i++) {
    const [x, y] = pts[i % bumps];
    const [px, py] = pts[i - 1];
    const chord = Math.hypot(x - px, y - py);
    d += ` A${chord * 0.6},${chord * 0.6} 0 0 1 ${x},${y}`;
  }
  return d + "Z";
}

export const RENDERERS: Record<string, Render> = {
  pill: (p, { id, w, h, theme }) => {
    const { fill, def } = paintToSvg(p.fill ?? "$pill", theme, `${id}-pf`);
    const color = c(p.color, theme, "$pillInk");
    const iconSize = h * 0.6;
    const pad = h * 0.32;
    const tx = p.icon ? pad + iconSize + h * 0.18 : pad;
    const fs = p.fontSize ?? h * 0.45;
    const tp = textPos(p, p.icon ? "left" : "center");
    return (
      <g>
        <defs>
          {def}
          {p.glow && <Glow id={`${id}-glow`} color={fill.startsWith("url") ? "#ffffff" : fill} std={8} />}
        </defs>
        <rect
          width={w} height={h} rx={h / 2} fill={fill}
          stroke={p.stroke ? c(p.stroke, theme, "#000") : undefined} strokeWidth={p.stroke ? 2 : undefined}
          filter={p.glow ? `url(#${id}-glow)` : undefined}
        />
        {p.icon && (
          <g transform={`translate(${pad} ${(h - iconSize) / 2})`}>
            <Icon name={p.icon} size={iconSize} color={color} />
          </g>
        )}
        <g transform={`translate(${tx + tp.dx} ${(h - fs) / 2 + tp.dy})`}>
          <TextBlock id={`${id}-t`} text={p.text ?? ""} w={w - tx - pad} h={fs * 1.2} size={fs} font={p.font ?? "body"} weight={p.weight ?? 800} align={tp.align} fill={color} theme={theme} fit="shrink" />
        </g>
      </g>
    );
  },

  qr: (p, { id, w, h, theme }) => {
    const labelH = p.label ? Math.min(h * 0.2, 52) : 0;
    const gap = p.label ? labelH * 0.35 : 0;
    const box = Math.min(w, h - labelH - gap);
    const bx = (w - box) / 2;
    const by = labelH + gap;
    let path = "";
    let n = 21;
    try {
      const qr = QRCode.create(p.url || " ", { errorCorrectionLevel: "M" });
      n = qr.modules.size;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) path += `M${x},${y}h1v1h-1z`;
    } catch { /* 無効なURL */ }
    const inner = box * 0.8;
    const cell = inner / n;
    // URL が未定なら、読み取れない example.com の QR ではなく、あとで URL を入れる空の枠を出す
    const empty = !String(p.url ?? "").trim();
    const hint = box * 0.075;
    return (
      <g>
        {p.label && RENDERERS.pill({ text: p.label, fill: p.labelFill ?? "$label1", color: p.labelColor ?? "$labelInk", fontSize: labelH * 0.5, textDx: p.labelDx, textDy: p.labelDy, textAlign: p.labelAlign }, { id: `${id}-l`, w, h: labelH, theme })}
        <rect x={bx} y={by} width={box} height={box} rx={box * 0.08} fill={c(p.frame, theme, "#ffffff")} stroke={c(p.border, theme, "$ink")} strokeWidth={Math.max(2, box * 0.025)} strokeDasharray={empty ? `${box * 0.05} ${box * 0.035}` : undefined} />
        {empty ? (
          <g transform={`translate(${bx + box * 0.1} ${by + box / 2 - hint * 1.4})`}>
            <TextBlock id={`${id}-e`} text={"QR コード\n（URL を入れてください）"} w={box * 0.8} h={hint * 2.8} size={hint} weight={700} font="body" align="center" fill="#8a8a8a" theme={theme} fit="shrink" />
          </g>
        ) : (
          <path d={path} transform={`translate(${bx + (box - inner) / 2} ${by + (box - inner) / 2}) scale(${cell})`} fill="#111" shapeRendering="crispEdges" />
        )}
      </g>
    );
  },

  iconText: (p, { id, w, h, theme }) => {
    const color = c(p.color, theme, "$ink");
    const is = h * 0.85;
    const fs = p.fontSize ?? h * 0.62;
    const tp = textPos(p, "left");
    return (
      <g>
        <g transform={`translate(0 ${(h - is) / 2})`}>
          <Icon name={p.icon ?? "calendar"} size={is} color={c(p.iconColor, theme, p.color ?? "$ink")} />
        </g>
        <g transform={`translate(${is * 1.35 + tp.dx} ${(h - fs) / 2 + tp.dy})`}>
          <TextBlock id={`${id}-t`} text={p.text ?? ""} w={w - is * 1.35} h={fs * 1.2} size={fs} weight={p.weight ?? 700} font={p.font ?? "body"} align={tp.align} fill={color} theme={theme} fit="shrink" />
        </g>
      </g>
    );
  },

  speechBubble: (p, { id, w, h, theme }) => {
    const shape = p.shape ?? "cloud";
    const { fill, def } = paintToSvg(p.fill ?? "$bubble", theme, `${id}-bf`);
    const stroke = c(p.stroke, theme, "$primary");
    const sw = p.strokeWidth ?? 4;
    const tail = p.tail ?? "bottom-right";
    const right = tail === "bottom-right";
    let body: ReactNode;
    if (shape === "cloud") body = <path d={cloudPath(w, h * 0.9)} />;
    else if (shape === "round") body = <ellipse cx={w / 2} cy={h * 0.45} rx={w * 0.48} ry={h * 0.43} />;
    else body = <rect x={sw} y={sw} width={w - sw * 2} height={h * 0.86} rx={Math.min(w, h) * 0.14} />;
    const tx = right ? w * 0.78 : w * 0.22;
    const tailEl =
      tail === "none" ? null : shape === "cloud" ? (
        <>
          <circle cx={tx} cy={h * 0.9} r={h * 0.045} />
          <circle cx={tx + (right ? 1 : -1) * w * 0.07} cy={h * 0.97} r={h * 0.028} />
        </>
      ) : (
        <path d={`M${tx - w * 0.06},${h * 0.8} L${tx + (right ? 1 : -1) * w * 0.1},${h} L${tx + w * 0.06},${h * 0.8}`} />
      );
    const fs = p.fontSize ?? Math.min(w, h) * 0.13;
    const padX = w * 0.17, padY = h * 0.17;
    const tp = textPos(p, "center");
    return (
      <g>
        <defs>{def}</defs>
        <g fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round">
          {body}
          {tailEl}
        </g>
        <g transform={`translate(${padX + tp.dx} ${padY + tp.dy}) rotate(${p.textRotate ?? 0} ${(w - padX * 2) / 2} ${h * 0.3})`}>
          <TextBlock id={`${id}-t`} text={p.text ?? ""} w={w - padX * 2} h={h * 0.9 - padY * 2} size={fs} lineHeight={1.3} font={p.font ?? "hand"} weight={p.weight ?? 600} align={tp.align} fill={c(p.color, theme, "$bubbleInk")} theme={theme} fit="shrink" />
        </g>
      </g>
    );
  },

  stickyNote: (p, { id, w, h, theme }) => {
    const fs = p.fontSize ?? Math.min(w, h) * 0.12;
    const color = c(p.color, theme, "$noteInk");
    const tp = textPos(p, "left");
    return (
      <g>
        <defs>
          <DropShadow id={`${id}-sh`} dx={2} dy={6} std={6} opacity={0.22} region={["-20%", "-20%", "140%", "140%"]} />
        </defs>
        <rect width={w} height={h} rx={3} fill={c(p.paper, theme, "$paper")} filter={`url(#${id}-sh)`} />
        <g transform={`translate(${w * 0.12 + tp.dx} ${h * 0.16 + tp.dy})`}>
          <TextBlock id={`${id}-t`} text={p.text ?? ""} w={w * 0.78} h={h * 0.6} size={fs} lineHeight={1.45} font={p.font ?? "hand"} weight={600} align={tp.align} fill={color} theme={theme} fit="shrink" />
        </g>
        {p.scribble !== false && (
          <path d={`M${w * 0.18},${h * 0.86} C${w * 0.4},${h * 0.8} ${w * 0.6},${h * 0.8} ${w * 0.86},${h * 0.74} M${w * 0.3},${h * 0.9} C${w * 0.5},${h * 0.86} ${w * 0.65},${h * 0.85} ${w * 0.8},${h * 0.82}`} stroke={color} strokeWidth={2.5} fill="none" strokeLinecap="round" />
        )}
        {p.tape !== false && <Tape x={w * 0.55} y={-h * 0.08} w={w * 0.38} h={h * 0.14} rotate={18} color={c(p.tapeColor, theme, "#e9d9a8")} />}
      </g>
    );
  },

  sparkle: (p, { id, w, h, theme }) => {
    const color = c(p.color, theme, "$accent");
    return (
      <g>
        {p.glow && <defs><Glow id={`${id}-g`} color={color} std={Math.max(w, h) * 0.12} /></defs>}
        <path d={sparklePath(w, h)} fill={p.outline ? "none" : color} stroke={p.outline ? color : undefined} strokeWidth={p.outline ? Math.max(2, w * 0.06) : undefined} strokeLinejoin="round" filter={p.glow ? `url(#${id}-g)` : undefined} />
      </g>
    );
  },

  stars: (p, { w, h, theme }) => {
    const r = rng(p.seed ?? 1);
    const color = c(p.color, theme, "#ffffff");
    const count = p.count ?? 60;
    const ratio = p.sparkleRatio ?? 0.15;
    return (
      <g fill={color}>
        {Array.from({ length: count }, (_, i) => {
          const x = r() * w, y = r() * h, s = r();
          if (s < ratio) {
            const sz = 10 + r() * 22;
            return <path key={i} d={sparklePath(sz, sz)} transform={`translate(${x - sz / 2} ${y - sz / 2})`} opacity={0.7 + r() * 0.3} />;
          }
          return <circle key={i} cx={x} cy={y} r={0.8 + r() * 2} opacity={0.35 + r() * 0.6} />;
        })}
      </g>
    );
  },

  burst: (p, { w, h, theme }) => {
    const color = c(p.color, theme, "$primary");
    const count = p.count ?? 3;
    const left = (p.side ?? "left") === "left";
    const fx = left ? w : 0, fy = h * 0.55;
    const span = 70;
    return (
      <g stroke={color} strokeWidth={p.thickness ?? 8} strokeLinecap="round">
        {Array.from({ length: count }, (_, i) => {
          const t = count === 1 ? 0 : i / (count - 1) - 0.5;
          // 焦点（タイトル側）から外へ放射状に伸びる線。left は左方向 (180°) を中心に扇形
          const ang = ((left ? 180 : 0) + t * span) * (Math.PI / 180);
          const R = Math.min(w, h * 1.2);
          return <line key={i} x1={fx + Math.cos(ang) * R * 0.3} y1={fy + Math.sin(ang) * R * 0.3} x2={fx + Math.cos(ang) * R} y2={fy + Math.sin(ang) * R} />;
        })}
      </g>
    );
  },

  brush: (p, { w, h, theme }) => {
    const r = rng(p.seed ?? 1);
    const steps = 14;
    const top = Array.from({ length: steps + 1 }, (_, i) => `${(i / steps) * w},${h * (0.12 + r() * 0.16)}`);
    const bot = Array.from({ length: steps + 1 }, (_, i) => `${((steps - i) / steps) * w},${h * (0.78 + r() * 0.16)}`);
    return (
      <path
        d={`M${-w * 0.01},${h * 0.5} L${top.join(" L")} L${w * 1.01},${h * 0.45} L${bot.join(" L")}Z`}
        fill={c(p.color, theme, "$highlight")} opacity={p.opacity ?? 0.85}
      />
    );
  },

  underline: (p, { w, h, theme }) => {
    const color = c(p.color, theme, "$primary");
    const t = p.thickness ?? 5;
    const style = p.style ?? "straight";
    let d: string;
    if (style === "wavy") {
      d = `M0,${h / 2}` + Array.from({ length: 8 }, (_, i) => ` Q${((i + 0.5) / 8) * w},${i % 2 ? h : 0} ${((i + 1) / 8) * w},${h / 2}`).join("");
    } else if (style === "double") {
      d = `M0,${h * 0.35} Q${w / 2},${h * 0.15} ${w},${h * 0.3} M${w * 0.08},${h * 0.8} Q${w / 2},${h * 0.6} ${w * 0.92},${h * 0.72}`;
    } else d = `M0,${h * 0.7} Q${w / 2},${h * 0.2} ${w},${h * 0.4}`;
    return <path d={d} stroke={color} strokeWidth={t} fill="none" strokeLinecap="round" />;
  },

  arrow: (p, { w, h, theme }) => {
    const color = c(p.color, theme, "$primary");
    const t = p.thickness ?? 4;
    const P = (x: number, y: number) => `${x * w},${y * h}`;
    const d = `M${P(0.02, 0.55)} C${P(0.25, 0.95)} ${P(0.5, 0.95)} ${P(0.45, 0.45)} C${P(0.4, 0.1)} ${P(0.22, 0.4)} ${P(0.35, 0.65)} C${P(0.48, 0.9)} ${P(0.78, 0.85)} ${P(0.96, 0.55)}`;
    const head = `M${P(0.8, 0.4)} L${P(0.97, 0.53)} L${P(0.8, 0.75)}`;
    return (
      <g transform={p.flip ? `translate(${w} 0) scale(-1 1)` : undefined} stroke={color} strokeWidth={t} fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
        <path d={head} />
      </g>
    );
  },

  icon: (p, { w, h, theme }) => <Icon name={p.name ?? "star"} size={Math.min(w, h)} color={c(p.color, theme, "$ink")} filled={p.filled} />,

  polaroid: (p, { id, w, h, theme }) => {
    const m = w * 0.06;
    const imgH = h - m - h * 0.2;
    const tp = textPos(p, "center");
    return (
      <g>
        <defs>
          <DropShadow id={`${id}-sh`} dx={2} dy={8} std={8} opacity={0.25} region={["-20%", "-20%", "140%", "140%"]} />
        </defs>
        <rect width={w} height={h} rx={4} fill="#fffdf8" filter={`url(#${id}-sh)`} />
        <g transform={`translate(${m} ${m})`}>
          <ImageBox id={`${id}-img`} src={p.src} asset={p.asset} w={w - m * 2} h={imgH} />
        </g>
        {p.caption && (
          <g transform={`translate(${m + tp.dx} ${m + imgH + h * 0.04 + tp.dy})`}>
            <TextBlock id={`${id}-c`} text={p.caption} w={w - m * 2} h={h * 0.12} size={h * 0.07} font="hand" align={tp.align} fill="#333" theme={theme} fit="shrink" />
          </g>
        )}
        {p.tape !== false && <Tape x={w * 0.3} y={-h * 0.04} w={w * 0.4} h={h * 0.09} rotate={-6} color="#eedfb0" />}
      </g>
    );
  },

  circlePhoto: (p, { id, w, h, theme }) => {
    const rw = Math.max(0, Number(p.ringWidth) || 0);
    return (
      <g>
        <ImageBox id={`${id}-img`} src={p.src} asset={p.asset} w={w} h={h} crop={p.crop} ellipse />
        {rw > 0 && (
          <ellipse cx={w / 2} cy={h / 2} rx={Math.max(0, (w - rw) / 2)} ry={Math.max(0, (h - rw) / 2)} fill="none" stroke={c(p.ring, theme, "$primary")} strokeWidth={rw} />
        )}
      </g>
    );
  },

  roundPhoto: (p, { id, w, h, theme }) => {
    const rw = Math.max(0, Number(p.ringWidth) || 0);
    const r = roundPhotoRadius(p, w, h);
    return (
      <g>
        <ImageBox id={`${id}-img`} src={p.src} asset={p.asset} w={w} h={h} crop={p.crop} radius={r} />
        {rw > 0 && (
          <rect x={rw / 2} y={rw / 2} width={Math.max(0, w - rw)} height={Math.max(0, h - rw)} rx={Math.max(0, r - rw / 2)} fill="none" stroke={c(p.ring, theme, "$primary")} strokeWidth={rw} />
        )}
      </g>
    );
  },

  laptop: (p, { id, w, h, theme }) => {
    const sh = h * 0.92;
    const bez = Math.min(w, h) * 0.035;
    return (
      <g>
        <defs>
          <DropShadow id={`${id}-sh`} dy={14} std={14} opacity={0.28} region={["-10%", "-10%", "120%", "130%"]} />
        </defs>
        <g filter={`url(#${id}-sh)`}>
          <rect x={w * 0.03} width={w * 0.94} height={sh} rx={bez * 1.6} fill={c(p.frame, theme, "#e9e9f2")} stroke="#c9c8d6" strokeWidth={2} />
          <path d={`M0,${sh} L${w},${sh} L${w * 0.97},${h} L${w * 0.03},${h} Z`} fill="#d7d6e2" />
          <rect x={w * 0.42} y={sh} width={w * 0.16} height={h * 0.025} rx={4} fill="#bdbccb" />
        </g>
        <g transform={`translate(${w * 0.03 + bez} ${bez})`}>
          <ImageBox id={`${id}-scr`} src={p.src} asset={p.asset} w={w * 0.94 - bez * 2} h={sh - bez * 2} radius={bez * 0.6} />
        </g>
        <circle cx={w / 2} cy={bez / 2} r={bez * 0.18} fill="#555" />
      </g>
    );
  },

  phone: (p, { id, w, h, theme }) => {
    const bez = w * 0.045;
    const r = w * 0.16;
    return (
      <g>
        <defs>
          <DropShadow id={`${id}-sh`} dy={12} std={12} opacity={0.3} region={["-20%", "-10%", "140%", "130%"]} />
        </defs>
        <rect width={w} height={h} rx={r} fill={c(p.frame, theme, "#1b1b24")} filter={`url(#${id}-sh)`} />
        <g transform={`translate(${bez} ${bez})`}>
          <ImageBox id={`${id}-scr`} src={p.src} asset={p.asset} w={w - bez * 2} h={h - bez * 2} radius={r - bez} />
        </g>
        <rect x={w * 0.34} y={bez * 1.3} width={w * 0.32} height={w * 0.07} rx={w * 0.035} fill={c(p.frame, theme, "#1b1b24")} />
      </g>
    );
  },

  checklist: (p, { id, w, h, theme }) => {
    const items: string[] = p.items ?? [];
    const fs = p.fontSize ?? 28;
    const gap = fs * (p.lineGap ?? 1.5);
    const color = c(p.color, theme, "$inkSoft");
    const cc = c(p.checkColor, theme, "$primary");
    const tp = textPos(p, "left");
    return (
      <g>
        {items.map((it, i) => (
          <g key={i} transform={`translate(0 ${i * gap})`}>
            <path d={`M${fs * 0.05},${fs * 0.55} L${fs * 0.35},${fs * 0.85} L${fs * 0.85},${fs * 0.15}`} stroke={cc} strokeWidth={fs * 0.09} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <g transform={`translate(${fs * 1.2 + tp.dx} ${tp.dy})`}>
              <TextBlock id={`${id}-${i}`} text={it} w={w - fs * 1.2} h={gap} size={fs} font={p.font ?? "hand"} weight={600} align={tp.align} fill={color} theme={theme} fit="shrink" />
            </g>
          </g>
        ))}
      </g>
    );
  },

  moon: (p, { id, w, h, theme }) => {
    const color = c(p.color, theme, "$accent");
    const r = Math.min(w, h) / 2;
    return (
      <g>
        <defs>
          <mask id={`${id}-m`}>
            <rect width={w} height={h} fill="#fff" />
            <circle cx={w / 2 + r * 0.42} cy={h / 2 - r * 0.25} r={r * 0.82} fill="#000" />
          </mask>
          {p.glow !== false && <Glow id={`${id}-g`} color={color} std={r * 0.18} />}
        </defs>
        <circle cx={w / 2} cy={h / 2} r={r * 0.92} fill={color} mask={`url(#${id}-m)`} filter={p.glow !== false ? `url(#${id}-g)` : undefined} />
      </g>
    );
  },

  tape: (p, { w, h, theme }) => <Tape x={0} y={0} w={w} h={h} rotate={0} color={c(p.color, theme, "#f3e3b5")} />,

  dots: (p, { w, h, theme }) => {
    const gap = p.gap ?? 16;
    const r0 = p.r ?? 2.5;
    const color = c(p.color, theme, "$primary");
    const out: ReactNode[] = [];
    for (let y = gap / 2; y < h; y += gap)
      for (let x = gap / 2; x < w; x += gap) {
        const k = p.fade === false ? 1 : 1 - Math.hypot(x / w - 0.5, y / h - 0.5) * 1.4;
        if (k > 0.05) out.push(<circle key={`${x},${y}`} cx={x} cy={y} r={r0 * k} />);
      }
    return <g fill={color}>{out}</g>;
  },
};
