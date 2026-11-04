/** 画像本来の幅/高さ。読み込み済みのものだけ同期で引ける（スクロールの量を決めるのに使う） */
const cache = new Map<string, number>();

export const cachedImageRatio = (src: string): number | undefined => cache.get(src);

/** 画像を読んで幅/高さを返す（読めない・大きさが無い画像は undefined） */
export function loadImageRatio(src: string): Promise<number | undefined> {
  const hit = cache.get(src);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const r = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : undefined;
      if (r) cache.set(src, r);
      resolve(r);
    };
    img.onerror = () => resolve(undefined);
    img.src = src;
  });
}
