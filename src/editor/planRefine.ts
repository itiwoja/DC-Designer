import type { PosterSpec } from "../schema";
import { renderSpecPng } from "../render/svg";
import type { RefImage } from "./api";
import { blobToRef } from "./reproduce";

export const MAX_PLAN_REFINE_ROUNDS = 3;

/**
 * ポン出しの自己添削を最大 rounds 周（既定 1、最大 3）: spec を描画 → send で AI に見せて直させる → 直した spec で次の周へ。
 * 直すところが無ければ（send が spec を返さなければ）そこで止める。返り値は最後に直した spec（直さなければ引数のまま）。
 * 通信は send で受け取る（api.ts は親がつなぐ）
 */
export async function refinePlannedPoster(
  spec: PosterSpec,
  send: (render: RefImage, spec: PosterSpec) => Promise<{ reply: string; spec?: PosterSpec }>,
  opts: { rounds?: number; signal?: AbortSignal; onRound?: (n: number) => void } = {},
): Promise<PosterSpec> {
  const rounds = Math.max(1, Math.min(MAX_PLAN_REFINE_ROUNDS, Math.floor(opts.rounds ?? 1)));
  let current = spec;
  for (let n = 1; n <= rounds; n++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    opts.onRound?.(n);
    const render = await blobToRef(await renderSpecPng(current));
    const res = await send(render, current);
    if (opts.signal?.aborted) throw new Error("aborted");
    if (!res.spec) break;
    current = res.spec;
  }
  return current;
}
