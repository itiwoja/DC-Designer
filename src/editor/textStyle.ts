import type { TextLayerT } from "../schema";

/** 太字とみなす太さの下限（PPTX の書き出しと同じ基準） */
const BOLD_FROM = 600;
export const isBold = (l: Pick<TextLayerT, "weight">) => (l.weight ?? 700) >= BOLD_FROM;

/**
 * Ctrl+B / Ctrl+U で切り替えるときの各レイヤーへのパッチ。Word と同じく、
 * 選んだものがすべてその書式なら外し、1 つでも違えば全部に付ける
 */
export function toggleTextStyle(layers: TextLayerT[], kind: "bold" | "underline"): { id: string; patch: Partial<TextLayerT> }[] {
  if (kind === "bold") {
    const on = !layers.every(isBold);
    return layers.map((l) => ({ id: l.id, patch: { weight: on ? 700 : 400 } }));
  }
  const on = !layers.every((l) => l.underline);
  return layers.map((l) => ({ id: l.id, patch: { underline: on || undefined } }));
}

/** Ctrl+B なら "bold"、Ctrl+U なら "underline"（ほかのキーや Shift/Alt 付きは null） */
export function textStyleKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): "bold" | "underline" | null {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return null;
  const k = e.key.toLowerCase();
  return k === "b" ? "bold" : k === "u" ? "underline" : null;
}
