import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { PosterSpec } from "../schema";
import { Poster } from "./Poster";

let nextId = 0;

/** フォント読み込み後の React の更新とレイアウトを待つ。非表示の窓では rAF が止まるので時間でも切る。 */
function waitForLayout(): Promise<void> {
  return new Promise((resolve) => {
    let frame: number;
    const finish = () => { clearTimeout(timer); cancelAnimationFrame(frame); resolve(); };
    const timer = setTimeout(finish, 100);
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
  });
}

/** 実寸の画面外 SVG を共用する。定義 ID を隔離し、成功・失敗のどちらでも React と DOM を片付ける。 */
export async function withOffscreenPoster<T>(spec: PosterSpec, fn: (svg: SVGSVGElement) => Promise<T>): Promise<T> {
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-100000px;top:0;pointer-events:none;width:${spec.meta.width}px;`;
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    let svg: SVGSVGElement | null = null;
    const idPrefix = `offscreen-${++nextId}-`;
    flushSync(() => root.render(createElement(Poster, { spec, idPrefix, ref: (el: SVGSVGElement | null) => { svg = el; } })));
    await document.fonts?.ready;
    await waitForLayout();
    if (!svg) throw new Error("ポスターを描画できませんでした");
    return await fn(svg);
  } finally {
    root.unmount();
    host.remove();
  }
}
