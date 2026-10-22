import type { Paint } from "./schema";
import { ensureWebFont, FALLBACK_FONT } from "./fonts";

export interface Theme {
  id: string;
  label: string;
  colors: Record<string, string>;
  gradients: Record<string, Paint>;
  fonts: Record<string, string>;
  /** 画像生成プロンプトに足すスタイル指示 */
  imageStyle: string;
}

const lin = (angle: number, ...colors: string[]): Paint => ({
  type: "linear",
  angle,
  stops: colors.map((color, i) => ({ offset: i / (colors.length - 1), color })),
});

const baseFonts = {
  display: "M PLUS Rounded 1c",
  body: "Zen Kaku Gothic New",
  hand: "Yomogi",
  heavy: "Dela Gothic One",
};

/**
 * すべてのテーマは同じトークン名を持つ。
 * レイアウトJSONはトークン（"$primary" など）で色を指定するので、テーマを差し替えるだけで別デザインになる。
 */
export const THEMES: Record<string, Theme> = {
  ocean: {
    id: "ocean",
    label: "Ocean（爽やか水色）",
    colors: {
      bg: "#eef8f7",
      bg2: "#dff1f6",
      ink: "#0e1a2b",
      inkSoft: "#33475b",
      inkInverse: "#ffffff",
      primary: "#139e9b",
      secondary: "#2a86e8",
      accent: "#f2c544",
      paper: "#fbf7ee",
      pill: "#cdeceb",
      pillInk: "#0e1a2b",
      highlight: "#9fdcd3",
      blob1: "#bfe6e3",
      blob2: "#cfe3fa",
      label1: "#cfe3fa",
      label2: "#2bb3a6",
      label3: "#cfe3fa",
      labelInk: "#0e1a2b",
      outline: "#ffffff",
      burst: "#18a7a0",
      star: "#ffffff",
      bubble: "#ffffff",
      bubbleInk: "#0e1a2b",
      noteInk: "#33475b",
    },
    gradients: {
      background: lin(160, "#f4fbfa", "#e3f3f6", "#eef7f2"),
      title: lin(0, "#0f9a8f", "#1a8fd6"),
      titleAccent: lin(0, "#1f8fe0", "#33b3e8"),
      ai: lin(0, "#10a39b", "#2a86e8"),
      titleSub: lin(0, "#0e1a2b", "#0e1a2b"),
    },
    fonts: baseFonts,
    imageStyle: "bright airy watercolor-like photo look, teal and sky blue palette, soft daylight",
  },
  sakura: {
    id: "sakura",
    label: "Sakura（ピンク×パープル）",
    colors: {
      bg: "#fdeaf3",
      bg2: "#efe4ff",
      ink: "#1a1230",
      inkSoft: "#4b3b62",
      inkInverse: "#ffffff",
      primary: "#ff3f9e",
      secondary: "#8d5cff",
      accent: "#ff8cc8",
      paper: "#fff6fb",
      pill: "#ffd3ea",
      pillInk: "#1a1230",
      highlight: "#ff9fcf",
      blob1: "#f7cfe6",
      blob2: "#dccbff",
      label1: "#9a6cff",
      label2: "#ff4fa6",
      label3: "#9a6cff",
      labelInk: "#ffffff",
      outline: "#ffffff",
      burst: "#ff4fa6",
      star: "#ffffff",
      bubble: "#ffffff",
      bubbleInk: "#1a1230",
      noteInk: "#4b3b62",
    },
    gradients: {
      background: lin(150, "#fff1f7", "#fbe3f1", "#ece4ff"),
      title: lin(0, "#ff3f9e", "#ff5fb0"),
      titleAccent: lin(0, "#ff3f9e", "#8d5cff"),
      ai: lin(0, "#ff2f92", "#ff5fb0"),
      titleSub: lin(0, "#1a1230", "#1a1230"),
    },
    fonts: baseFonts,
    imageStyle: "cute pastel pink and lavender, kawaii, soft glow, dreamy",
  },
  night: {
    id: "night",
    label: "Night（星空×ラベンダー）",
    colors: {
      bg: "#141838",
      bg2: "#2b2463",
      ink: "#ffffff",
      inkSoft: "#e4e0ff",
      inkInverse: "#1a1640",
      primary: "#b49bff",
      secondary: "#ffb3dc",
      accent: "#ffd76a",
      paper: "#f4ecdf",
      pill: "#f6e8ff",
      pillInk: "#1a1640",
      highlight: "#9b7dff",
      blob1: "#3a2f7a",
      blob2: "#4a3a8f",
      label1: "#d9b8ff",
      label2: "#ffb3cf",
      label3: "#b8c8ff",
      labelInk: "#1a1640",
      outline: "#2a1f66",
      burst: "#ffd76a",
      star: "#ffffff",
      bubble: "#1d1846",
      bubbleInk: "#ffffff",
      noteInk: "#3a3358",
    },
    gradients: {
      background: { type: "radial", cx: 0.5, cy: 0.35, r: 0.9, stops: [
        { offset: 0, color: "#2e2a6e" }, { offset: 0.6, color: "#1a1b45" }, { offset: 1, color: "#0f1230" },
      ] },
      title: lin(90, "#fff6d8", "#f3dcff", "#c9a8ff"),
      titleAccent: lin(90, "#fff2c4", "#e5c9ff", "#b08cff"),
      ai: lin(90, "#fff2c9", "#e9c8ff", "#a885ff"),
      titleSub: lin(90, "#ffffff", "#efe2ff", "#cdb4ff"),
    },
    fonts: baseFonts,
    imageStyle: "dreamy night sky, lavender and indigo palette, glowing stars, soft magical lighting",
  },
  notebook: {
    id: "notebook",
    label: "Notebook（白×手書き）",
    colors: {
      bg: "#f6f5f1",
      bg2: "#ffffff",
      ink: "#111111",
      inkSoft: "#2a3550",
      inkInverse: "#ffffff",
      primary: "#18b4ef",
      secondary: "#ffe53d",
      accent: "#1a7cff",
      paper: "#ffffff",
      pill: "#ffe94d",
      pillInk: "#111111",
      highlight: "#ffe94d",
      blob1: "#ffffff",
      blob2: "#eef6fb",
      label1: "#3aa8f0",
      label2: "#21b3a6",
      label3: "#3aa8f0",
      labelInk: "#ffffff",
      outline: "#ffffff",
      burst: "#ffd91a",
      star: "#ffffff",
      bubble: "#ffffff",
      bubbleInk: "#111111",
      noteInk: "#2a3550",
    },
    gradients: {
      background: lin(90, "#f8f7f3", "#f1f0eb"),
      title: lin(0, "#111111", "#111111"),
      titleAccent: lin(0, "#111111", "#111111"),
      ai: lin(0, "#14c3f5", "#1aa0ff"),
      titleSub: lin(0, "#111111", "#111111"),
    },
    fonts: baseFonts,
    imageStyle: "clean minimal flat illustration, white paper, crisp, blue and yellow accents",
  },
};

export function resolveTheme(id: string, override?: { colors?: Record<string, string>; gradients?: Record<string, Paint>; fonts?: Record<string, string> }): Theme {
  const base = THEMES[id] ?? THEMES.ocean;
  if (!override) return base;
  return {
    ...base,
    colors: { ...base.colors, ...override.colors },
    gradients: { ...base.gradients, ...override.gradients },
    fonts: { ...base.fonts, ...override.fonts },
  };
}

/** "$primary" → "#139e9b"。グラデーショントークンは Paint で返す */
export function resolvePaint(p: Paint | undefined, theme: Theme): Paint | undefined {
  if (p === undefined) return undefined;
  if (typeof p === "string") {
    if (p.startsWith("$")) {
      const key = p.slice(1);
      if (key in theme.gradients) return resolvePaint(theme.gradients[key], theme);
      return theme.colors[key] ?? "#ff00ff";
    }
    return p;
  }
  return { ...p, stops: p.stops.map((s) => ({ ...s, color: resolveColor(s.color, theme) })) } as Paint;
}

export function resolveColor(c: string | undefined, theme: Theme): string {
  if (!c) return "none";
  if (c.startsWith("$")) {
    const v = resolvePaint(c, theme);
    if (typeof v === "string") return v;
    return v?.stops[0].color ?? "#ff00ff";
  }
  return c;
}

export function resolveFont(f: string | undefined, theme: Theme): string {
  const name = theme.fonts[f ?? "body"] ?? f ?? theme.fonts.body;
  ensureWebFont(name); // カタログのフォントは使われた時点で読み込む（index.html で読み込んでいないもの）
  return `'${name}', '${FALLBACK_FONT}', sans-serif`;
}
