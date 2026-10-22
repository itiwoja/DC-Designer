import { useState } from "react";
import { readPref, writePref } from "./storage";

/**
 * ドラッグで変えられるパネルの大きさ（px）。null は既定（CSS の値）のまま。
 * 画面が狭くなったときにはみ出さないよう、上限は呼び出し側で画面の大きさから決める
 */
export function usePanelSize(key: string) {
  const [size, setSize] = useState<number | null>(() => {
    const v = Number(readPref(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  });
  const update = (v: number | null) => { setSize(v); writePref(key, v === null ? "" : String(Math.round(v))); };
  return [size, update] as const;
}

/**
 * パネルの縁に置くつまみ。ドラッグで大きさを変え、ダブルクリックで既定に戻す。
 * edge はつまみがパネルのどちら側の縁にあるか（right = 左パネルの右縁。右へ引くと広がる）
 */
export function Resizer({
  className, edge, label, min, max, getSize, onResize, onDragging,
}: {
  className: string;
  edge: "right" | "left" | "top";
  label: string;
  min: number;
  max: number;
  /** ドラッグを始めたときの今の大きさ（既定のままなら実際の大きさを測る） */
  getSize: () => number;
  onResize: (size: number | null) => void;
  /** ドラッグ中はパネルの開閉アニメーションを止める */
  onDragging: (on: boolean) => void;
}) {
  const clamp = (v: number) => Math.min(Math.max(v, min), Math.max(min, max));
  const sign = edge === "right" ? 1 : -1;
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = edge === "top" ? e.clientY : e.clientX;
    const base = getSize();
    onDragging(true);
    const move = (ev: PointerEvent) => onResize(clamp(base + sign * ((edge === "top" ? ev.clientY : ev.clientX) - start)));
    const up = () => {
      onDragging(false);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  // キーボードでも矢印キーで少しずつ変えられる
  const onKeyDown = (e: React.KeyboardEvent) => {
    const grow = edge === "top" ? "ArrowUp" : edge === "right" ? "ArrowRight" : "ArrowLeft";
    const shrink = edge === "top" ? "ArrowDown" : edge === "right" ? "ArrowLeft" : "ArrowRight";
    const step = e.shiftKey ? 48 : 16;
    if (e.key === grow) onResize(clamp(getSize() + step));
    else if (e.key === shrink) onResize(clamp(getSize() - step));
    else if (e.key === "Enter") onResize(null);
    else return;
    e.preventDefault();
  };
  return (
    <div
      className={"resizer " + className}
      role="separator"
      aria-orientation={edge === "top" ? "horizontal" : "vertical"}
      aria-label={label}
      title={`ドラッグで${label}（ダブルクリックで元に戻す）`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onResize(null)}
      onKeyDown={onKeyDown}
    />
  );
}
