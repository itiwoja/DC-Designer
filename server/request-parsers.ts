import { PosterSpecSchema } from "../src/schema";
import { isAiSubject, type AiSubject } from "../desktop/aiPayload";
import { httpError } from "./http-error";
import type { AcrossDeck, ChatTurn, DeckContext } from "./planner";

export const optString = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
export const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : []);

/** PPTX の全スライド（{ current, total, slides: [{ number, title?, spec? | texts? }] }）。spec は書き換え・統合の対象、texts は文字だけの参考 */
export function parseDeckContext(v: any): DeckContext | undefined {
  if (!v || !Array.isArray(v.slides)) return undefined;
  const current = Number(v.current), total = Number(v.total);
  if (!Number.isInteger(current) || !Number.isInteger(total)) return undefined;
  const slides = v.slides.map((s: any) => ({
    number: Number(s?.number),
    title: typeof s?.title === "string" ? s.title : undefined,
    spec: s?.spec == null ? undefined : PosterSpecSchema.parse(s.spec),
    texts: Array.isArray(s?.texts) ? s.texts.filter((t: unknown): t is string => typeof t === "string").slice(0, 30) : undefined,
  }));
  return { current, total, slides: slides.filter((s: { number: number; spec?: unknown; texts?: unknown }) => Number.isInteger(s.number) && (s.spec || s.texts)), instagram: v.instagram === true };
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
