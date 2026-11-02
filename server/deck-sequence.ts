import { PosterSpecSchema, type PosterSpec } from "../src/schema";

/** 編集後のデッキの並び。数値 = 元のスライド番号（1 始まり）、{ spec } = 新しく作るスライド */
export type DeckSlot = number | { spec: PosterSpec };

type Options = {
  total: number;
  /** spec が渡されている（書き換え・削除してよい）スライドの番号。これ以外は文字だけの参考で、必ず残す */
  editable: number[];
  /** 新規スライドの spec の検証。既定は PosterSpecSchema.parse */
  parseSpec?: (raw: unknown) => PosterSpec;
};

/**
 * AI が返した sequence を検証して DeckSlot[] にそろえる。構成を変えないなら undefined。
 * 数値は 1..total の整数、{ spec }（または {new: spec}）は新規スライド。
 * 文字だけの参考スライドを落とした並び・空の並びはエラー（generateJson が AI にやり直させる）
 */
export function normalizeSequence(raw: unknown, { total, editable, parseSpec = (v) => PosterSpecSchema.parse(v) }: Options): DeckSlot[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new Error('"sequence" は配列（スライド番号と {"spec": ...} の並び）にしてください');
  if (!raw.length) throw new Error('"sequence" が空です。構成を変えないなら null にしてください');
  const slots = raw.map((item, i): DeckSlot => {
    if (typeof item === "number" || typeof item === "string") {
      const n = Number(item);
      if (typeof item === "string" && !item.trim()) throw new Error(`sequence の ${i + 1} 番目が空です`);
      if (!Number.isInteger(n) || n < 1 || n > total) throw new Error(`sequence の番号は 1〜${total} の整数にしてください（受け取った値: ${String(item)}）`);
      return n;
    }
    const o = item as { spec?: unknown; new?: unknown } | null;
    const spec = o?.spec ?? o?.new;
    if (spec == null || typeof spec !== "object") throw new Error(`sequence の ${i + 1} 番目は番号か {"spec": PosterSpec} にしてください`);
    return { spec: parseSpec(spec) };
  });
  const used = new Set(slots.filter((s): s is number => typeof s === "number"));
  const lost = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !used.has(n) && !editable.includes(n));
  if (lost.length) throw new Error(`文字だけの参考スライド ${lost.join(", ")} は削除できません。sequence に残してください`);
  const same = slots.length === total && slots.every((s, i) => s === i + 1);
  return same ? undefined : slots;
}

/** 旧形式の remove（消すスライド番号）を sequence 相当の並びに直す。消すものが無ければ undefined */
export function removeToSequence(remove: number[], total: number): number[] | undefined {
  if (!remove.length) return undefined;
  const seq = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !remove.includes(n));
  return seq.length ? seq : undefined;
}
