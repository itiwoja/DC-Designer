/**
 * 発表者ビュー（Issue #76）の窓と画面の選び方。electron を import しない純粋関数だけを置く（テストできるように）。
 */
import type { PresenterDisplay } from "./bridge";

/** 発表者ビューの window.open が付ける窓の名前 */
export const PRESENTER_FRAME_NAME = "dc-designer-presenter";

/** Electron の Display のうち使う部分だけ */
export type DisplayLike = {
  id: number;
  label?: string;
  bounds: { width: number; height: number };
};

/** 許すのは「編集窓が開いた、名前つきの空の窓」だけ。それ以外は今までどおり拒否する */
export function isPresenterPopup(o: { url: string; frameName: string; fromEditor: boolean }): boolean {
  return o.fromEditor && o.frameName === PRESENTER_FRAME_NAME && (o.url === "about:blank" || o.url === "");
}

const has = (displays: readonly DisplayLike[], id: number | null | undefined): id is number =>
  typeof id === "number" && displays.some((d) => d.id === id);

/**
 * スライドを映す画面を選ぶ。
 * 指定があって見つかればそれ。なければ、発表者ビューの窓があり画面が 2 つ以上ならメイン画面、そうでなければ編集窓が今ある画面。
 */
export function pickSlideDisplay(
  displays: readonly DisplayLike[],
  o: { requested?: number; hasView: boolean; editorDisplayId: number | null; primaryId?: number | null },
): number | null {
  if (displays.length === 0) return null;
  if (has(displays, o.requested)) return o.requested;
  if (o.hasView && displays.length >= 2 && has(displays, o.primaryId)) return o.primaryId;
  if (has(displays, o.editorDisplayId)) return o.editorDisplayId;
  return has(displays, o.primaryId) ? o.primaryId : displays[0].id;
}

/**
 * 発表者ビューの窓を置く画面を選ぶ。画面が 1 つならスライドと同じ（移さない）。
 * 2 つ以上なら、編集窓が元いた画面がスライドの画面と違えばそこ、同じなら別の画面のうち先頭。
 */
export function pickViewDisplay(
  displays: readonly DisplayLike[],
  slideId: number | null,
  editorDisplayId: number | null,
): number | null {
  if (displays.length === 0) return null;
  if (displays.length === 1) return displays[0].id;
  if (editorDisplayId !== slideId && has(displays, editorDisplayId)) return editorDisplayId;
  return displays.find((d) => d.id !== slideId)?.id ?? displays[0].id;
}

/** 画面へ返す一覧。メイン画面を先頭に、残りは元の順 */
export function toPresenterDisplays(displays: readonly DisplayLike[], primaryId: number): PresenterDisplay[] {
  let n = 0;
  const list = displays.map((d) => {
    const primary = d.id === primaryId;
    if (!primary) n += 1;
    const size = `${d.bounds.width}×${d.bounds.height}`;
    const name = d.label?.trim();
    const label = name ? `${name}（${size}）` : primary ? `メイン画面（${size}）` : `画面 ${n + 1}（${size}）`;
    return { id: d.id, label, primary };
  });
  return [...list.filter((d) => d.primary), ...list.filter((d) => !d.primary)];
}
