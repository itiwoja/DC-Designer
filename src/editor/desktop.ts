import type { DesktopBridge, PrepareCloseRequest } from "../../desktop/bridge";

/** 製品版（Electron）なら preload の橋、開発版（ブラウザ）なら undefined */
export function desktopBridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.dcDesktop;
}

// ---------- 閉じる前の保存準備 ----------
// 保存関数の登録簿。フックが複数マウントされても、全部の保存が済んでから1回だけ complete する
type SaveAll = () => Promise<boolean>;
const savers = new Set<SaveAll>();

const nextFrame = () => new Promise<void>((resolve) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => resolve()) : setTimeout(resolve, 0)));

/** 閉じる要求に応じて保存し、結果を main へ返す */
export async function handlePrepareClose(bridge: DesktopBridge, { requestId }: PrepareCloseRequest) {
  let allSaved = false;
  try {
    // IME の確定待ちの文字を確定させてから保存に入る
    (document.activeElement as HTMLElement | null)?.blur?.();
    await nextFrame();
    const results = await Promise.all([...savers].map((save) => save().catch(() => false)));
    allSaved = results.every(Boolean);
  } catch { /* 保存できなかった扱い */ }
  bridge.close.complete({ requestId, allSaved, busy: false });
}

/**
 * 製品版で閉じる要求を受け付ける（画面の種類によらず常に答える。保存関数が無ければそのまま allSaved）。
 * 戻り値は解除関数
 */
export function listenForClose(): () => void {
  const bridge = desktopBridge();
  if (!bridge) return () => {};
  return bridge.close.onPrepare((req) => { void handlePrepareClose(bridge, req); });
}

/** 製品版でだけ、閉じる前に呼ぶ保存関数を登録する。戻り値は解除関数 */
export function registerCloseSave(save: SaveAll): () => void {
  if (!desktopBridge()) return () => {};
  savers.add(save);
  return () => { savers.delete(save); };
}
