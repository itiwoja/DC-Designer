import type { PosterSpec } from "../schema";
import type { DeckSlot } from "./api";

/** 最終の並びの 1 枠 */
export type PlannedSlot =
  /** 既存のスライドをそのまま使う */
  | { type: "keep"; id: string; n: number }
  /** 同じ番号の 2 回目以降: from（元のスライド id）の書き換え後の複製を新しく作る */
  | { type: "copy"; from: string; n: number }
  /** AI が新しく作ったスライド */
  | { type: "new"; spec: PosterSpec };

export type DeckSequencePlan = {
  /** 最終の並び */
  slots: PlannedSlot[];
  /** 書き換える既存のスライド（並びに残るものだけ） */
  rewrites: { id: string; n: number; spec: PosterSpec }[];
  /** 消す既存のスライドの id（元の並び順） */
  removed: string[];
};

/**
 * AI が返した並び（sequence）を、デッキの操作に落とす純粋な計算。
 * oldIds は今のデッキの id（番号 = 位置 + 1）、edits は元のスライド番号ごとの書き換え後の spec。
 * 範囲外の番号は無視する。同じ番号の 2 回目以降は複製、{spec} は新規
 */
export function planDeckSequence(oldIds: string[], sequence: DeckSlot[], edits: ReadonlyMap<number, PosterSpec>): DeckSequencePlan {
  const seen = new Set<number>();
  const slots: PlannedSlot[] = [];
  for (const slot of sequence) {
    if (typeof slot !== "number") { slots.push({ type: "new", spec: slot.spec }); continue; }
    const id = oldIds[slot - 1];
    if (!Number.isInteger(slot) || !id) continue;
    if (seen.has(slot)) slots.push({ type: "copy", from: id, n: slot });
    else { seen.add(slot); slots.push({ type: "keep", id, n: slot }); }
  }
  const rewrites = [...seen].sort((a, b) => a - b).flatMap((n) => {
    const spec = edits.get(n);
    return spec ? [{ id: oldIds[n - 1], n, spec }] : [];
  });
  const removed = oldIds.filter((_, i) => !seen.has(i + 1));
  return { slots, rewrites, removed };
}

/**
 * 開いているスライド（openId）が消えるとき、先に開くスライドを選ぶ: 最終の並び（keptIds = 残る既存のスライドの並び）のうち、
 * 元の位置に一番近いもの。残るスライドが無ければ null
 */
export function nearestKept(oldIds: string[], keptIds: string[], openId: string): string | null {
  const at = oldIds.indexOf(openId);
  if (at < 0 || !keptIds.length) return null;
  let best = keptIds[0], gap = Infinity;
  for (const id of keptIds) {
    const g = Math.abs(oldIds.indexOf(id) - at);
    // 同じ距離なら後ろ側（削除ボタンと同じく次のスライドを優先）
    if (g < gap || (g === gap && oldIds.indexOf(id) > at)) { best = id; gap = g; }
  }
  return best;
}
