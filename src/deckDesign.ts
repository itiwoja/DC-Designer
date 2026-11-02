/**
 * デッキのデザイン（テーマ・配色・フォント・共通要素）の要約と、AI の修正でデザインが崩れないようにする保険。React 非依存。
 * 画面（App.tsx / useDeck.ts）が要約を作って /api/edit に渡し、サーバー（planner.ts）がプロンプトに入れ、結果に keepDeckDesign をかける
 */
import type { Layer, PosterSpec } from "./schema";
import { findPageNumber } from "./editor/pageNumbers";

/** 複数のスライドで同じ位置・同じ見た目に置かれているレイヤー（ヘッダーの帯・ページ番号・ロゴ・フッターなど） */
export type CommonLayer = {
  /** 何の要素か（「ページ番号」「ヘッダーの帯」「ロゴ」「フッター」など。分からなければ「共通の図形」など） */
  role: string;
  /** 代表のレイヤー（1 枚目に見つかったスライドのもの。text は代表の文面）。AI に見せる見本でもあり、保険の照合にも使う */
  layer: Layer;
  /** このレイヤーを持つスライドの枚数 */
  count: number;
};

export type DeckDesign = {
  /** 要約に使ったスライドの枚数 */
  slides: number;
  /** 多数派のテーマ */
  theme: string;
  /** 多数派の themeOverride（無ければ省略） */
  themeOverride?: PosterSpec["themeOverride"];
  /** よく使われている色（多い順、最大 8。"$primary" のようなテーマトークンもそのまま） */
  colors: { color: string; use: "background" | "text" | "shape"; count: number }[];
  /** よく使われているフォント（多い順、最大 5。"display" / "body" / "hand" のトークンもそのまま） */
  fonts: { font: string; weight: number; count: number }[];
  /** 複数のスライドで共通の要素（最大 6） */
  common: CommonLayer[];
  /** 見出し（各スライドでいちばん大きい文字）の典型的な位置と大きさ（中央値） */
  heading?: { x: number; y: number; size: number; font: string; weight: number; fill: string };
  /** 文字の左右の余白（中央値。px） */
  margin?: { left: number; right: number };
};

// ---- 内部の道具 ----

const median = (xs: number[]) => {
  const a = [...xs].sort((p, q) => p - q), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
/** 値を数えて多い順に並べる（同数なら先に出たほうが先） */
function tally<T>(items: T[], key: (t: T) => string): { item: T; count: number }[] {
  const m = new Map<string, { item: T; count: number }>();
  for (const it of items) { const k = key(it), e = m.get(k); if (e) e.count++; else m.set(k, { item: it, count: 1 }); }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/** 見た目（色・フォント・大きさ・部品名・画像）の同一判定に使う文字列。位置と text の文面は含めない */
function look(l: Layer): string {
  switch (l.type) {
    case "text": return JSON.stringify([l.font, l.size, l.weight, l.fill]);
    case "shape": return JSON.stringify([l.shape, l.fill, l.stroke]);
    case "component": return JSON.stringify([l.component]);
    case "image": return JSON.stringify([l.src]);
    default: return "";
  }
}

/** 同じ種類・近い位置と大きさ（キャンバスの幅・高さの 2% 以内）・同じ見た目か。common の判定と keepDeckDesign の照合で共用する */
function similar(a: Layer, b: Layer, aSize: { width: number; height: number }, bSize = aSize): boolean {
  return a.type === b.type && sameBox(a, b, aSize, bSize) && look(a) === look(b);
}
function sameBox(a: Layer, b: Layer, aSize: { width: number; height: number }, bSize = aSize): boolean {
  const tx = Math.max(aSize.width, bSize.width) * 0.02, ty = Math.max(aSize.height, bSize.height) * 0.02;
  return Math.abs(a.x - b.x) <= tx && Math.abs(a.w - b.w) <= tx && Math.abs(a.y - b.y) <= ty && Math.abs(a.h - b.h) <= ty;
}

function roleOf(spec: PosterSpec, l: Layer): string {
  const { width: W, height: H } = spec.meta;
  if (findPageNumber(spec)?.layer === l) return "ページ番号";
  const cy = l.y + l.h / 2;
  if (l.type === "image") return "ロゴ・画像";
  if (l.type === "shape" && l.w >= W * 0.6 && cy <= H * 0.2) return "ヘッダーの帯";
  if (cy >= H * 0.88 && l.type !== "component") return "フッター";
  return "共通の要素";
}

/**
 * スライドの枠の要素か（ページ番号、上端・下端・左右の端にある帯・ロゴ・フッターなど）。共通要素はこれに限る。
 * 本文や見出しは全スライドで同じ位置・同じ書式でも、リデザインで動かしてよいので含めない（上端の文字は、そのスライドのいちばん大きい文字の 6 割未満の小さなものだけ）
 */
function isFrame(spec: PosterSpec, l: Layer): boolean {
  const { width: W, height: H } = spec.meta;
  if (l.type === "text" && findPageNumber(spec)?.layer === l) return true;
  const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
  const bottom = cy >= H * 0.85, top = cy <= H * 0.15, side = cx <= W * 0.08 || cx >= W * 0.92;
  if (l.type !== "text") return bottom || top || side;
  const max = Math.max(...spec.layers.map((m) => (m.type === "text" ? m.size : 0)));
  return bottom || ((top || side) && l.size < max * 0.6);
}

const fillText = (p: unknown) => (typeof p === "string" ? p : JSON.stringify(p));

/** デッキのスライドの spec からデザインを要約する。2 枚未満なら undefined */
export function summarizeDeckDesign(specs: PosterSpec[]): DeckDesign | undefined {
  if (specs.length < 2) return undefined;
  const n = specs.length;
  const theme = tally(specs, (s) => s.theme)[0].item.theme;
  const ov = tally(specs, (s) => JSON.stringify(s.themeOverride) ?? "")[0].item.themeOverride;

  const layers = specs.flatMap((s) => s.layers.filter((l) => l.type !== "group").map((l) => l));
  const colorUses = layers.flatMap((l) => {
    const f = l.type === "background" || l.type === "text" || l.type === "shape" ? l.fill : undefined;
    return typeof f === "string" ? [{ color: f, use: l.type as "background" | "text" | "shape" }] : [];
  });
  const colors = tally(colorUses, (c) => `${c.use}|${c.color}`).slice(0, 8).map(({ item, count }) => ({ ...item, count }));
  const fontUses = layers.flatMap((l) => (l.type === "text" ? [{ font: l.font, weight: l.weight }] : []));
  const fonts = tally(fontUses, (f) => `${f.font}|${f.weight}`).slice(0, 5).map(({ item, count }) => ({ ...item, count }));

  // 共通要素: トップレベルのレイヤーを先頭のスライドから順にまとめ、似たものが 2 枚以上かつ 4 割以上のスライドにあれば共通
  const used = specs.map(() => new Set<Layer>());
  const common: CommonLayer[] = [];
  const need = Math.max(2, Math.ceil(n * 0.4));
  for (const [i, spec] of specs.entries()) {
    for (const l of spec.layers) {
      if (l.type === "background" || l.type === "group" || used[i].has(l) || !isFrame(spec, l)) continue;
      used[i].add(l);
      let count = 1;
      for (let j = i + 1; j < n; j++) {
        const hit = specs[j].layers.find((m) => !used[j].has(m) && m.type !== "background" && isFrame(specs[j], m) && similar(l, m, spec.meta, specs[j].meta));
        if (hit) { used[j].add(hit); count++; }
      }
      if (count >= need) common.push({ role: roleOf(spec, l), layer: l, count });
    }
  }
  common.sort((a, b) => b.count - a.count);

  // 見出し: 各スライドでいちばん大きい text
  const heads = specs.flatMap((s) => {
    const ts = s.layers.filter((l) => l.type === "text");
    return ts.length ? [ts.reduce((a, b) => (b.size > a.size ? b : a))] : [];
  });
  const heading = heads.length ? (() => {
    const top = <T,>(f: (l: typeof heads[number]) => T, key: (v: T) => string) => tally(heads.map(f), key)[0].item;
    return {
      x: median(heads.map((h) => h.x)), y: median(heads.map((h) => h.y)), size: median(heads.map((h) => h.size)),
      font: top((h) => h.font, String), weight: top((h) => h.weight, String), fill: top((h) => fillText(h.fill), String),
    };
  })() : undefined;

  // 余白: スライドごとに text の左端の最小と右の余白の最小を求め、中央値をとる
  const sides = specs.flatMap((s) => {
    const ts = s.layers.filter((l) => l.type === "text");
    return ts.length ? [{ left: Math.min(...ts.map((t) => t.x)), right: Math.min(...ts.map((t) => s.meta.width - t.x - t.w)) }] : [];
  });
  const margin = sides.length ? { left: Math.round(median(sides.map((m) => m.left))), right: Math.round(median(sides.map((m) => m.right))) } : undefined;

  return {
    slides: n, theme, ...(ov ? { themeOverride: ov } : {}), colors, fonts, common: common.slice(0, 6),
    ...(heading ? { heading } : {}), ...(margin ? { margin } : {}),
  };
}

/**
 * 指示が色・テーマ・配色・フォント・雰囲気・ブランドなど、デッキのデザインそのものを変える指示か。
 * 「リデザインして」「作り直して」「見やすくして」だけなら false（デザインの範囲で中身を直す）
 */
export function wantsDesignChange(text: string): boolean {
  // 「色々」「景色」「特色」「顔色」「色んな」の色は色の話ではない
  const t = text.normalize("NFKC").replace(/色々|いろいろ|(?<!背)景色|特色|顔色|色んな/g, "");
  return /配色|色味|カラー|テーマ|フォント|書体|字体|テイスト|雰囲気|トーン|ブランド|一新|ポップ|シック|派手|落ち着いた|ダーク|(?<!ハイ)ライト|全体のデザインを変え|背景色/.test(t)
    || /色[をもがにで]/.test(t);
}

/** 共通要素の role ごとに、指示がその要素を名指しするときの語 */
const ROLE_WORDS: Record<string, RegExp> = {
  "ページ番号": /ページ番号|スライド番号|番号|ノンブル/,
  "ヘッダーの帯": /ヘッダー|帯|上の|見出しの帯/,
  "フッター": /フッター|下の|帯/,
  "ロゴ・画像": /ロゴ|画像|写真/,
};

const flat = (layers: Layer[]): Layer[] => layers.flatMap((l) => (l.type === "group" ? [l, ...flat(l.children)] : [l]));

/** グループの中も含めて、レイヤーを fn で置き換える（変わらなければ同じ参照） */
function mapDeep(layers: Layer[], fn: (l: Layer) => Layer): Layer[] {
  let changed = false;
  const out = layers.map((l) => {
    const m = l.type === "group" ? (() => { const c = mapDeep(l.children, fn); return c === l.children ? l : { ...l, children: c }; })() : l;
    const r = fn(m);
    if (r !== l) changed = true;
    return r;
  });
  return changed ? out : layers;
}

/**
 * AI が返した spec（edited）を、元の spec（original）と比べて、デッキのデザインを崩す変更を元に戻す。
 * instruction がデザインを変える指示（wantsDesignChange）なら何もしない。
 * - theme / themeOverride が変わっていたら元に戻す
 * - 元からあったテキストレイヤーのフォント（font）が変わっていたら元に戻す
 * - 元の spec にあった共通要素（design.common に一致するレイヤー）が消えた・動いた・見た目が変わったら元に戻す。
 *   ただし instruction がその要素を名指ししている（「ページ番号を消して」「ロゴを右上に」）か、selectedIds に入っていれば戻さない
 * restored には戻したものを日本語で入れる（例: 「テーマと配色」「ページ番号」）。何も戻さなければ空配列で、spec は edited のまま
 */
export function keepDeckDesign(
  original: PosterSpec, edited: PosterSpec, design: DeckDesign, instruction: string, selectedIds?: string[],
): { spec: PosterSpec; restored: string[] } {
  if (wantsDesignChange(instruction)) return { spec: edited, restored: [] };
  const instr = instruction.normalize("NFKC");
  const restored: string[] = [];
  let spec = edited;

  if (edited.theme !== original.theme || JSON.stringify(edited.themeOverride) !== JSON.stringify(original.themeOverride)) {
    const { themeOverride: _drop, ...rest } = spec;
    spec = { ...rest, theme: original.theme, ...(original.themeOverride ? { themeOverride: original.themeOverride } : {}) };
    restored.push("テーマと配色");
  }

  const origFonts = new Map(flat(original.layers).flatMap((l) => (l.type === "text" ? [[l.id, l.font] as const] : [])));
  const fonted = mapDeep(spec.layers, (l) => (l.type === "text" && origFonts.has(l.id) && origFonts.get(l.id) !== l.font ? { ...l, font: origFonts.get(l.id)! } : l));
  if (fonted !== spec.layers) { spec = { ...spec, layers: fonted }; restored.push("フォント"); }

  // 共通要素
  const named = (role: string, l: Layer) =>
    !!ROLE_WORDS[role]?.test(instr) || (selectedIds ?? []).includes(l.id)
    || (!!l.name && instr.includes(l.name.normalize("NFKC")))
    || (l.type === "text" && l.text.trim().length >= 2 && instr.includes(l.text.trim().normalize("NFKC")));
  let layers = spec.layers;
  const all = new Set(flat(layers).map((l) => l.id));
  for (const [i, o] of original.layers.entries()) {
    if (o.type === "background") continue;
    const c = design.common.find((c) => similar(c.layer, o, original.meta));
    if (!c || named(c.role, o)) continue;
    const idx = layers.findIndex((l) => l.id === o.id);
    if (idx < 0) {
      if (all.has(o.id)) continue; // グループの中へ動かされた。ここでは戻さない
      layers = [...layers.slice(0, i), o, ...layers.slice(i)];
    } else if (!similar(o, layers[idx], edited.meta, original.meta)) {
      layers = layers.map((l, k) => (k === idx ? o : l));
    } else continue;
    if (!restored.includes(c.role)) restored.push(c.role);
  }
  if (layers !== spec.layers) spec = { ...spec, layers };

  return { spec, restored };
}

/** デッキのデザインを保つため元に戻したものの注記（restored は「テーマと配色」「ページ番号」など） */
export const designNote = (restored: string[]) => `（デッキのデザインに合わせて、${restored.join("・")}は元のままにしました。変えたいときは「配色も変えて」「テーマも変えて」のように頼んでください）`;

const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);
const USE: Record<string, string> = { background: "背景", text: "文字", shape: "図形" };

/** プロンプトに入れるデッキのデザインの説明（見出し付きの Markdown） */
export function deckDesignPrompt(design: DeckDesign): string {
  const lines = [
    "# デッキのデザイン（ほかのスライドと共通。保つこと）",
    "",
    "- 「リデザイン」「作り直して」「見やすくして」は、デッキのデザインの範囲でレイアウト・情報の整理・強弱を変えること。",
    "- theme / themeOverride / 配色 / フォント / 共通要素は、ユーザーが色・テーマ・フォント・雰囲気を変えるようはっきり頼んだときだけ変える。",
    "- 新しく足す要素の色はテーマトークン（$primary など）か、下のデッキで使われている色から選ぶ。デッキに無い色を持ち込まない。フォントも下のフォントから選ぶ。",
    "- 共通要素（ページ番号・ヘッダー・ロゴなど）は位置・大きさ・色をそのまま残す。",
    "- 見出しの位置と大きさ・左右の余白もそろえる。",
    "",
    `- スライド数: ${design.slides}`,
    `- theme: ${design.theme}`,
    `- themeOverride: ${design.themeOverride ? clip(JSON.stringify(design.themeOverride), 600) : "なし"}`,
    `- 色: ${design.colors.map((c) => `${c.color}（${USE[c.use]} ${c.count}回）`).join("、") || "なし"}`,
    `- フォント: ${design.fonts.map((f) => `${f.font} ${f.weight}（${f.count}回）`).join("、") || "なし"}`,
  ];
  const h = design.heading;
  if (h) lines.push(`- 見出し: x=${h.x} y=${h.y} size=${h.size} font=${h.font} weight=${h.weight} fill=${clip(h.fill, 60)}`);
  if (design.margin) lines.push(`- 余白: 左 ${design.margin.left}px / 右 ${design.margin.right}px`);
  if (design.common.length) {
    lines.push("- 共通要素:");
    for (const c of design.common) {
      const l = c.layer.type === "text" ? { ...c.layer, text: clip(c.layer.text) } : c.layer;
      lines.push(`  - ${c.role}（${c.count}枚）: ${clip(JSON.stringify(l, (k, v) => (k === "animation" || k === "props" ? undefined : v)), 500)}`);
    }
  }
  return lines.join("\n");
}
