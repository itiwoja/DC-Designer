import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** 読み込み・デコードが済んだ画像（一度済めば、同じ画像で読み込み中を出し直さない） */
const decoded = new Set<string>();
const inflight = new Map<string, Promise<void>>();

function decode(src: string): Promise<void> {
  let p = inflight.get(src);
  if (!p) {
    const img = new Image();
    img.src = src;
    // 読み込めなかった画像も「済み」にする（ぐるぐるが消えなくならないように）
    p = img.decode().catch(() => {}).then(() => { decoded.add(src); inflight.delete(src); });
    inflight.set(src, p);
  }
  return p;
}

/** 画像を先に読み込み・デコードしておく（プロジェクトを開いたとき、ほかのスライドの画像も済ませておき、切り替えで待たせない） */
export function preloadImages(srcs: Iterable<string>) {
  for (const s of srcs) if (!decoded.has(s)) decode(s);
}

/**
 * svg 内の画像（<image>）とフォントが描ける状態になったか。
 * 描画のたびに中の画像を調べ、まだの画像があれば読み込み・デコードを待つ
 */
export function useRenderReady(ref: RefObject<SVGSVGElement | null>): boolean {
  const [ready, setReady] = useState(true);
  const waitingKey = useRef("");
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const srcs = new Set<string>();
    svg.querySelectorAll("image").forEach((el) => {
      const s = el.getAttribute("href") || el.getAttribute("xlink:href");
      if (s && !decoded.has(s)) srcs.add(s);
    });
    const fontsLoading = document.fonts?.status === "loading";
    const key = [...srcs].join("\n") + (fontsLoading ? "\n@fonts" : "");
    if (key === waitingKey.current) return;
    waitingKey.current = key;
    if (!key) { setReady(true); return; }
    setReady(false);
    Promise.all([...[...srcs].map(decode), fontsLoading ? document.fonts.ready : null]).then(() => {
      if (waitingKey.current !== key) return;
      waitingKey.current = "";
      setReady(true);
    });
  });
  return ready;
}
