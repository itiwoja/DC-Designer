import type { PosterSpec, SlideBgm } from "./schema";

/**
 * スライドの BGM。効果音（src/sounds.ts）と違って長い曲を流すので、全部をデコードせず <audio> で少しずつ読んで鳴らす。
 * 同時に流れる BGM は 1 つだけ（新しく流すと前の曲は止まる）
 */

/** 取り込める BGM。効果音より長い曲を入れるので大きめ（サーバーは 20MB まで） */
export const BGM_FILE_MAX_BYTES = 15 * 1024 * 1024;

/** list の from 番目以降で、最初の「クリック時」の BGM の番号（無ければ -1） */
export const nextClickBgm = (list: SlideBgm[], from: number) => {
  const i = list.slice(from).findIndex((b) => b.start === "click");
  return i < 0 ? -1 : from + i;
};

const FADE_MS = 400;

export type BgmPlayer = {
  /** 流している曲（無ければ null） */
  current: () => SlideBgm | null;
  /** 曲を流す。同じ曲がもう流れていればそのまま続ける。onEnded は（繰り返さない曲が）最後まで流れたとき */
  play: (bgm: SlideBgm, onEnded?: () => void) => void;
  /** 止める（少しずつ小さくして止め、ブツッと切らない） */
  stop: () => void;
};

export function createBgmPlayer(): BgmPlayer {
  let el: HTMLAudioElement | null = null;
  let cur: SlideBgm | null = null;
  const fadeOut = (a: HTMLAudioElement) => {
    const from = a.volume, t0 = performance.now();
    const step = () => {
      const u = (performance.now() - t0) / FADE_MS;
      if (u >= 1) { a.pause(); a.removeAttribute("src"); a.load(); return; }
      a.volume = from * (1 - u);
      requestAnimationFrame(step);
    };
    step();
  };
  const stop = () => {
    if (el) { el.onended = null; fadeOut(el); }
    el = null;
    cur = null;
  };
  return {
    current: () => cur,
    play: (bgm, onEnded) => {
      if (el && cur?.src === bgm.src && !el.paused) {
        el.loop = bgm.loop;
        el.onended = () => { el = null; cur = null; onEnded?.(); };
        cur = bgm;
        return;
      }
      stop();
      const a = new Audio(bgm.src);
      a.loop = bgm.loop;
      a.play().catch((e) => console.warn(`BGM「${bgm.name}」を流せませんでした:`, e));
      // 繰り返さない曲が終わったら、流していない扱いにする
      a.onended = () => { if (el === a) { el = null; cur = null; onEnded?.(); } };
      el = a;
      cur = bgm;
    },
    stop,
  };
}

/** 先に読み込んでおく（スライドショーで流し始めが遅れないように） */
export function preloadBgm(specs: PosterSpec[]) {
  const seen = new Set<string>();
  for (const s of specs) {
    for (const { src } of s.bgm ?? []) {
      if (seen.has(src)) continue;
      seen.add(src);
      const a = new Audio();
      a.preload = "auto";
      a.src = src;
    }
  }
}
