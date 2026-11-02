/** スライド一覧での複数選択（Ctrl/⌘ ＋クリックで追加・解除、Shift ＋クリックで範囲）。画面に依存しない純粋な計算 */
export type SlideSelection = {
  /** 複数選択中の id（一覧の順。空 = 複数選択なし） */
  selected: string[];
  /** 範囲選択の起点 */
  anchor: string | null;
  /** 指定があれば、そのスライドを開く */
  open?: string;
};

/** 一覧の順に並べ直し、1 件以下なら空（1 枚だけなら通常の状態と同じ）にする */
function normalize(order: readonly string[], ids: ReadonlySet<string>): string[] {
  const list = order.filter((id) => ids.has(id));
  return list.length >= 2 ? list : [];
}

/**
 * クリックされたスライドから、次の選択の状態を求める。
 * - ふつうのクリック: そのスライドを開き、選択は空に戻す
 * - Ctrl/⌘: 選択に入れる／外す（空のときは開いているスライドと一緒に始める）。開かない
 * - Shift: 起点（無ければ開いているスライド）からの範囲。Ctrl も押していれば既存の選択に足す。開かない
 */
export function nextSlideSelection(
  order: string[],
  selected: readonly string[],
  currentId: string | null,
  anchorId: string | null,
  clicked: string,
  mod: { ctrl: boolean; shift: boolean },
): SlideSelection {
  if (!order.includes(clicked)) return { selected: normalize(order, new Set(selected)), anchor: anchorId };
  if (!mod.ctrl && !mod.shift) return { selected: [], anchor: clicked, open: clicked };
  const base = new Set(selected.length > 0 ? selected : currentId ? [currentId] : []);
  if (mod.shift) {
    const from = [anchorId, currentId, clicked].find((id): id is string => !!id && order.includes(id))!;
    const a = order.indexOf(from), b = order.indexOf(clicked);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    const ids = new Set(mod.ctrl ? [...base, ...range] : range);
    return { selected: normalize(order, ids), anchor: from };
  }
  if (base.has(clicked)) base.delete(clicked);
  else base.add(clicked);
  return { selected: normalize(order, base), anchor: clicked };
}
