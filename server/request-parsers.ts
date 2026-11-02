import { LayerSchema, PosterSpecSchema } from "../src/schema";
import type { CommonLayer, DeckDesign } from "../src/deckDesign";
import { isAiSubject, type AiSubject } from "../desktop/aiPayload";
import { httpError } from "./http-error";
import type { AcrossDeck, ChatTurn, DeckContext } from "./planner";

export const optString = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
export const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : []);

/** PPTX の全スライド（{ current, total, slides: [{ number, title?, spec? | texts?, notes?, theme?, colors? }] }）。spec は書き換え・統合の対象、texts・notes・theme・colors は文字だけの参考 */
export function parseDeckContext(v: any): DeckContext | undefined {
  if (!v || !Array.isArray(v.slides)) return undefined;
  const current = Number(v.current), total = Number(v.total);
  if (!Number.isInteger(current) || !Number.isInteger(total)) return undefined;
  const slides = v.slides.map((s: any) => {
    const colors = strings(s?.colors, 12).map((c) => c.slice(0, 60));
    return {
      number: Number(s?.number),
      title: typeof s?.title === "string" ? s.title : undefined,
      spec: s?.spec == null ? undefined : PosterSpecSchema.parse(s.spec),
      texts: Array.isArray(s?.texts) ? s.texts.filter((t: unknown): t is string => typeof t === "string").slice(0, 30) : undefined,
      notes: typeof s?.notes === "string" ? s.notes.slice(0, 1000) : undefined,
      theme: optString(s?.theme, 60),
      colors: colors.length ? colors : undefined,
    };
  });
  // スライド一覧で選択中の番号（整数・範囲内だけ残す）
  const selected = Array.isArray(v.selected) ? [...new Set<number>(v.selected.map(Number))].filter((n: number) => Number.isInteger(n) && n >= 1 && n <= total).sort((a: number, b: number) => a - b) : [];
  return { current, total, ...(selected.length ? { selected } : {}), slides: slides.filter((s: { number: number; spec?: unknown; texts?: unknown; colors?: unknown }) => Number.isInteger(s.number) && (s.spec || s.texts || s.colors)) };
}

export function parseAcross(v: any): AcrossDeck | undefined {
  const number = Number(v?.number), total = Number(v?.total);
  if (!Number.isInteger(number) || !Number.isInteger(total) || number < 1 || number > total) return undefined;
  return { number, total, guide: optString(v?.guide, 1000) };
}

/** チャットのやりとり（{ role: "user" | "assistant" | "note", text }[]）。1 発言は 1000 文字まで */
export function parseTurns(v: unknown): ChatTurn[] {
  return (Array.isArray(v) ? v : [])
    .filter((t: any) => (t?.role === "user" || t?.role === "assistant" || t?.role === "note") && typeof t.text === "string" && t.text.trim())
    .map((t: any) => ({ role: t.role, text: String(t.text).slice(0, 1000) }));
}

/** 画像（{ mediaType, data: base64 }）。再現 API の参考画像・描画結果 */
export function parseImage(v: any, name: string) {
  if (typeof v?.mediaType !== "string" || !/^image\/(png|jpeg|webp|gif)$/.test(v.mediaType) || typeof v?.data !== "string" || !v.data) {
    throw httpError(400, `${name} は { mediaType, data } の画像で指定してください`);
  }
  return { mediaType: v.mediaType as string, data: v.data as string };
}

/** AI 依頼の対象作品（{ kind: "poster" | "deck", id, title }）。無ければ undefined、形が違えば 400 */
export function parseSubject(v: unknown): AiSubject | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isAiSubject(v)) throw httpError(400, "subject の形式が正しくありません");
  return { kind: v.kind, id: v.id, title: v.title };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";

/** 画面が作ったデッキのデザインの要約（/api/edit の design）。形が違えば undefined（デザインを保つ処理なしで続ける） */
export function parseDeckDesign(v: unknown): DeckDesign | undefined {
  const o = v as any;
  if (!o || typeof o !== "object" || Array.isArray(o) || !str(o.theme)) return undefined;
  const themeOverride = o.themeOverride && typeof o.themeOverride === "object" ? PosterSpecSchema.shape.themeOverride.safeParse(o.themeOverride) : undefined;
  const list = (x: unknown, max: number): any[] => (Array.isArray(x) ? x.filter((e) => e && typeof e === "object").slice(0, max) : []);
  const colors = list(o.colors, 8).filter((c) => str(c.color) && (c.use === "background" || c.use === "text" || c.use === "shape") && finite(c.count))
    .map((c) => ({ color: c.color as string, use: c.use as "background" | "text" | "shape", count: c.count as number }));
  const fonts = list(o.fonts, 5).filter((f) => str(f.font) && finite(f.weight) && finite(f.count)).map((f) => ({ font: f.font as string, weight: f.weight as number, count: f.count as number }));
  const common = list(o.common, 6).flatMap((c): CommonLayer[] => {
    const layer = LayerSchema.safeParse(c.layer);
    return str(c.role) && finite(c.count) && layer.success ? [{ role: c.role, layer: layer.data, count: c.count }] : [];
  });
  const h = o.heading, m = o.margin;
  const heading = h && finite(h.x) && finite(h.y) && finite(h.size) && str(h.font) && finite(h.weight) && str(h.fill)
    ? { x: h.x, y: h.y, size: h.size, font: h.font, weight: h.weight, fill: h.fill } : undefined;
  const margin = m && finite(m.left) && finite(m.right) ? { left: m.left, right: m.right } : undefined;
  const design: DeckDesign = {
    slides: Number.isInteger(o.slides) ? o.slides : 0, theme: o.theme,
    ...(themeOverride?.success && themeOverride.data ? { themeOverride: themeOverride.data } : {}),
    colors, fonts, common, ...(heading ? { heading } : {}), ...(margin ? { margin } : {}),
  };
  // 大きすぎるときは共通要素（レイヤーの実物）から減らす
  while (design.common.length && JSON.stringify(design).length > 20000) design.common = design.common.slice(0, -1);
  return design;
}
