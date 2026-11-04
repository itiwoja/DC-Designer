// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { hideGroup, pendingScrolls, playGroup, slideGroups } from "../src/render/animatePreview";
import { PosterSpecSchema } from "../src/schema";
import type { AnimGroup } from "../src/animation";

// jsdom は画像を読み込めないので、読み込みは「大きさが分からなかった」で即座に終わらせる
vi.mock("../src/render/imageRatio", () => ({ cachedImageRatio: () => undefined, loadImageRatio: () => Promise.resolve(undefined) }));

const svgWith = (ids: string[]) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const id of ids) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("data-layer-id", id);
    svg.appendChild(g);
  }
  return svg;
};

const group = (items: [string, string][]): AnimGroup =>
  ({ auto: false, steps: [{ offset: 0, items: items.map(([id, effect]) => ({ id, offset: 0, anim: { effect, start: "click", duration: 500, delay: 0 } })) }] }) as unknown as AnimGroup;

describe("スライドショーでまだ出していないまとまり", () => {
  it("入場の効果は隠し、スクロールの画像は最初から見せる", () => {
    const svg = svgWith(["t", "img"]);
    hideGroup(svg, group([["t", "fade"], ["img", "scroll"]]), true);
    const el = (id: string) => svg.querySelector<SVGGElement>(`[data-layer-id="${id}"]`)!;
    expect(el("t").style.visibility).toBe("hidden");
    expect(el("img").style.visibility).toBe("");
    hideGroup(svg, group([["t", "fade"], ["img", "scroll"]]), false);
    expect(el("t").style.visibility).toBe("");
  });
});

describe("スクロールの位置と読み込み", () => {
  const frame = { x: 0, y: 0, w: 100, h: 100 };
  const specWith = (crop?: { ratio: number }) => PosterSpecSchema.parse({ meta: {}, layers: [
    { id: "img", type: "image", src: "/shot.png", ...frame, ...(crop ? { crop: { x: 0, y: 0, w: 1, h: 1, ...crop } } : {}), animation: { effect: "scroll", direction: "bottom", start: "click", duration: 500, delay: 0 } },
  ] });
  const build = (spec: ReturnType<typeof specWith>) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("data-layer-id", "img");
    const img = document.createElementNS("http://www.w3.org/2000/svg", "image");
    img.setAttribute("data-scroll-image", "");
    g.appendChild(img);
    svg.appendChild(g);
    document.body.appendChild(svg);
    const calls: { kf: Keyframe[]; opts: KeyframeAnimationOptions }[] = [];
    const live: { cancel: () => void }[] = [];
    (img as unknown as { animate: unknown }).animate = (kf: Keyframe[], opts: KeyframeAnimationOptions) => {
      calls.push({ kf, opts });
      const a = { cancel: () => live.splice(live.indexOf(a), 1), finish: () => undefined, finished: Promise.resolve() };
      live.push(a);
      return a;
    };
    (img as unknown as { getAnimations: unknown }).getAnimations = () => [...live];
    return { svg, calls, live, groups: slideGroups(spec) };
  };

  it("流し終えたまとまりは、流し終えた位置で表示する（隠すと取り消す）", () => {
    const spec = specWith({ ratio: 0.5 });
    const { svg, calls, live, groups } = build(spec);
    hideGroup(svg, groups[0], false);
    // 画像は幅 100・高さ 200 → 100 だけ上へ
    expect(calls).toHaveLength(1);
    expect(calls[0].kf).toEqual([{ translate: "0px -100px" }]);
    expect(calls[0].opts.fill).toBe("forwards");
    hideGroup(svg, groups[0], true);
    expect(live).toHaveLength(0);
  });

  it("再生時に比率が無ければ読み込みを待つ（待ちの対象を見つける）", () => {
    const spec = specWith();
    const { groups } = build(spec);
    expect(pendingScrolls(spec, groups[0])).toEqual(["img"]);
    expect(pendingScrolls(specWith({ ratio: 0.5 }), groups[0])).toEqual([]);
  });

  it("読み込み待ちの間に取り消したら、始めない", async () => {
    const spec = specWith();
    const { svg, calls, groups } = build(spec);
    const run = playGroup(svg, spec, groups[0]);
    run.cancel();
    await run.done;
    expect(calls).toHaveLength(0);
  });
});
