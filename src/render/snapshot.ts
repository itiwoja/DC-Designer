import { withOffscreenPoster } from "./offscreen";
import { buildExportSvg } from "./svg";
import type { PosterSpec } from "../schema";

/**
 * サムネイル用の受動的な描画 snapshot。
 * spec を画面外に描き、画像を data URL に埋めた自己完結の SVG にして Blob URL で返す（<img> で表示するのでスクリプトも外部資源も動かない）。
 * 同じ内容の spec は結果を使い回し、描画は少数ずつ順に行う
 */

type Entry = { url?: string; promise: Promise<string>; refs: number; dead?: boolean };

export type SnapshotDeps = {
  /** spec から SVG の Blob を作る */
  make: (spec: PosterSpec) => Promise<Blob>;
  createUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
};

export type SnapshotHandle = { promise: Promise<string>; release: () => void };

const keyOf = new WeakMap<object, string>();
/** spec の中身が同じかどうかの鍵（同じ参照なら計算し直さない） */
export function specKey(spec: PosterSpec): string {
  let k = keyOf.get(spec);
  if (k === undefined) { k = JSON.stringify(spec); keyOf.set(spec, k); }
  return k;
}

/**
 * snapshot の保管庫。acquire で借り、不要になったら release で返す。
 * 誰も借りていない結果は idleMax 件まで残し（並べ替えなどの付け外しで作り直さない）、溢れた分の Blob URL を revoke する
 */
export function createSnapshotStore(deps: SnapshotDeps, opts: { concurrency?: number; idleMax?: number } = {}) {
  const concurrency = opts.concurrency ?? 2;
  const idleMax = opts.idleMax ?? 24; // 画像を data URL で抱えるので多く残さない
  const entries = new Map<string, Entry>();
  const idle: string[] = []; // 借り手のいない鍵（古い順）
  const waiting: (() => void)[] = [];
  let running = 0;

  const pump = () => {
    while (running < concurrency && waiting.length) { running++; waiting.shift()!(); }
  };
  const drop = (key: string) => {
    const e = entries.get(key);
    if (!e) return;
    e.dead = true;
    if (e.url) deps.revokeUrl(e.url);
    entries.delete(key);
  };

  function acquire(spec: PosterSpec): SnapshotHandle {
    const key = specKey(spec);
    let e = entries.get(key);
    if (e) {
      const i = idle.indexOf(key);
      if (i >= 0) idle.splice(i, 1);
    } else {
      const entry: Entry = { refs: 0, promise: undefined as unknown as Promise<string> };
      entry.promise = new Promise<string>((resolve, reject) => {
        waiting.push(() => {
          // 始まる前に誰も要らなくなった仕事は飛ばす
          if (entry.dead) { running--; pump(); reject(new Error("cancelled")); return; }
          deps.make(spec).then((blob) => {
            if (entry.dead) return reject(new Error("cancelled"));
            entry.url = deps.createUrl(blob);
            resolve(entry.url);
          }, reject).finally(() => { running--; pump(); });
        });
        pump();
      });
      entry.promise.catch(() => { if (entries.get(key) === entry) entries.delete(key); });
      entries.set(key, entry);
      e = entry;
    }
    e.refs++;
    const mine = e;
    let released = false;
    return {
      promise: mine.promise,
      release: () => {
        if (released) return;
        released = true;
        if (--mine.refs > 0 || entries.get(key) !== mine) return;
        // 作成中・待ち中の仕事は捨てる。出来上がったものは少し残す
        if (!mine.url) { drop(key); return; }
        idle.push(key);
        while (idle.length > idleMax) drop(idle.shift()!);
      },
    };
  }

  return { acquire, size: () => entries.size };
}

/** spec を画面外に実寸で描き、画像を埋めた SVG の Blob にする（フォントは埋め込まない） */
async function makeSnapshotBlob(spec: PosterSpec): Promise<Blob> {
  return withOffscreenPoster(spec, async (svg) => {
    const text = await buildExportSvg(svg, spec, { embedFonts: false });
    return new Blob([text], { type: "image/svg+xml" });
  });
}

export const snapshots = createSnapshotStore({
  make: makeSnapshotBlob,
  createUrl: (b) => URL.createObjectURL(b),
  revokeUrl: (u) => URL.revokeObjectURL(u),
});
