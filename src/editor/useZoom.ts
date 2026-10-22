import { useCallback, useEffect, useLayoutEffect, useState, type PointerEvent as RPointerEvent, type RefObject } from "react";

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * キャンバスのズームと表示位置。
 * - "fit" はステージに収まる倍率（ステージの大きさが変わると測り直す）
 * - Ctrl/⌘ + ホイール（トラックパッドのピンチ）でズーム。ブラウザ全体のズームは抑止する
 * - onPlainWheel が true を返したら、修飾キーなしのホイールをそちらで使う（トリミング中の拡大縮小）
 */
export function useZoom(stageRef: RefObject<HTMLDivElement | null>, W: number, H: number, onPlainWheel: RefObject<((deltaY: number) => boolean) | null>) {
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [fitScale, setFitScale] = useState(0.5);
  // Alt+ドラッグで動かした表示位置（画面 px）
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const scale = zoom === "fit" ? fitScale : zoom;

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // ステージは左右のパネルの下まで広がっているので、padding（パネル・ツールバーの分）を除いた広さに収める
    const measure = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      setFitScale(Math.max(0.05, Math.min(w / W, h / H)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stageRef, W, H]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) {
        if (onPlainWheel.current?.(e.deltaY)) e.preventDefault();
        return;
      }
      e.preventDefault();
      setZoom((z) => Math.max(0.1, Math.min(4, (z === "fit" ? fitScale : z) * Math.exp(-e.deltaY * 0.0015))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stageRef, fitScale, onPlainWheel]);

  const zoomBy = useCallback((dir: 1 | -1) => setZoom((z) => {
    const cur = z === "fit" ? fitScale : z;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > cur + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.001);
    return next ?? cur;
  }), [fitScale]);

  /** 全体表示に戻す（Alt+ドラッグで動かした位置もリセット） */
  const fitView = useCallback(() => { setZoom("fit"); setPan({ x: 0, y: 0 }); }, []);

  /** Alt+ドラッグでキャンバスの表示位置を動かす（要素の上からでも） */
  const startPanView = (e: RPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY }, from = pan;
    setPanning(true);
    const move = (ev: PointerEvent) => setPan({ x: from.x + ev.clientX - start.x, y: from.y + ev.clientY - start.y });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPanning(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return { zoom, setZoom, scale, pan, panning, zoomBy, fitView, startPanView };
}
