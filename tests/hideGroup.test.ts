// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { hideGroup } from "../src/render/animatePreview";
import type { AnimGroup } from "../src/animation";

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
