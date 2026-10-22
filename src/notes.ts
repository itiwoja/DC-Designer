import type { Layer, PosterSpec } from "./schema";

/** 台本を書くときに渡すスライドの中身。レイヤーの座標や色は台本に要らないので、読む順の文字と画像の説明だけ */
export type SlideContent = { texts: string[]; images: string[] };

/**
 * スライドの文字（チェックリストの項目も）を読む順（上の行から、同じ行は左から）に並べ、画像は生成プロンプトかキャプションで説明する。
 * 非表示・別テーマ用のレイヤーは見えないので入れない
 */
export function slideContent(spec: PosterSpec): SlideContent {
  type Item = { x: number; y: number; h: number; text?: string; image?: string };
  const items: Item[] = [];
  const walk = (l: Layer, ox: number, oy: number) => {
    if (l.visible === false || (l.themes && !l.themes.includes(spec.theme))) return;
    const x = ox + l.x, y = oy + l.y;
    const add = (it: Omit<Item, "x" | "y" | "h">) => items.push({ x, y, h: l.h, ...it });
    if (l.type === "group") l.children.forEach((c) => walk(c, x, y));
    else if (l.type === "text") add({ text: l.text });
    else if (l.type === "image") add({ image: l.asset?.prompt || "" });
    else if (l.type === "component") {
      const p = l.props ?? {};
      const words = ["text", "label"].map((k) => p[k]).filter((v): v is string => typeof v === "string");
      if (Array.isArray(p.items)) words.push(p.items.filter((v: unknown): v is string => typeof v === "string").map((v: string) => `・${v}`).join("\n"));
      if (words.length) add({ text: words.join("\n") });
      // 写真の部品（src か asset を持つ）は画像として、キャプションがあれば説明に使う
      if ("src" in p || "asset" in p) add({ image: [typeof p.caption === "string" ? p.caption : "", p.asset?.prompt ?? ""].filter(Boolean).join(" / ") });
      else if (typeof p.caption === "string") add({ text: p.caption });
    }
  };
  spec.layers.forEach((l) => walk(l, 0, 0));
  // 上端の差が行の高さの半分より小さければ同じ行とみなし、左から読む
  items.sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) / 2 ? a.x - b.x : a.y - b.y));
  return {
    texts: items.flatMap((i) => (i.text?.trim() ? [i.text.trim()] : [])),
    images: items.flatMap((i) => (i.image === undefined ? [] : [i.image.trim().slice(0, 200) || "（説明なし）"])),
  };
}

/** 既存の台本の長さ（字数）の目安。新しい台本の長さをそろえるのに使う。台本が無ければ null */
export function notesLength(notes: (string | undefined)[]): { median: number; min: number; max: number; count: number } | null {
  const lens = notes.map((n) => n?.replace(/\s/g, "").length ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  if (!lens.length) return null;
  const mid = lens.length >> 1;
  const median = lens.length % 2 ? lens[mid] : Math.round((lens[mid - 1] + lens[mid]) / 2);
  return { median, min: lens[0], max: lens[lens.length - 1], count: lens.length };
}
