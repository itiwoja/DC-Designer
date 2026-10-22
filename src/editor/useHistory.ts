import { useCallback, useRef, useState } from "react";

/** 文書 1 つ分の Undo/Redo の履歴（スライドを切り替えるときに預けておき、戻ったら続きから使う） */
export type HistoryStacks<T> = { past: T[]; future: T[] };

/** 単純な Undo/Redo 付き state。coalesceKey が同じ連続更新（ドラッグ等）は 1 手にまとめる */
export function useHistory<T>(initial: T) {
  const [state, setState] = useState(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const lastKey = useRef<string | null>(null);

  const set = useCallback((next: T | ((prev: T) => T), coalesceKey?: string) => {
    setState((prev) => {
      const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      if (value === prev) return prev;
      if (!coalesceKey || coalesceKey !== lastKey.current) {
        past.current.push(prev);
        if (past.current.length > 200) past.current.shift();
      }
      future.current = [];
      lastKey.current = coalesceKey ?? null;
      return value;
    });
  }, []);

  const undo = useCallback(() => {
    setState((prev) => {
      const p = past.current.pop();
      if (p === undefined) return prev;
      future.current.push(prev);
      lastKey.current = null;
      return p;
    });
  }, []);

  const redo = useCallback(() => {
    setState((prev) => {
      const f = future.current.pop();
      if (f === undefined) return prev;
      past.current.push(prev);
      lastKey.current = null;
      return f;
    });
  }, []);

  /** 今の文書の履歴を取り出す（別のスライドへ切り替える前に預ける） */
  const stash = useCallback((): HistoryStacks<T> => ({ past: past.current, future: future.current }), []);

  /** 別の文書（スライド）に切り替える。stacks を渡せばその文書の履歴の続きから、無ければ履歴なしで始める */
  const reset = useCallback((value: T, stacks?: HistoryStacks<T>) => {
    past.current = stacks?.past ?? [];
    future.current = stacks?.future ?? [];
    lastKey.current = null;
    setState(value);
  }, []);

  // 履歴は ref だが、state が変わるたびに再描画されるので描画時点の値で十分
  return { state, set, reset, stash, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
