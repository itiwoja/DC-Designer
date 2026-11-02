import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextBlock } from "../src/render/TextBlock";
import { THEMES } from "../src/themes";
import { matchWeight, syntheticWeight } from "../src/fonts";

describe("文字の太さ", () => {
  it("太さを持たないフォントに 900 を指定しても、偽の太字を作らせない（縁取りの層も同じ）", () => {
    const theme = Object.values(THEMES)[0];
    const html = renderToStaticMarkup(createElement(TextBlock, {
      id: "title", text: "星空観察会", w: 840, h: 143, theme, font: "heavy", size: 130, weight: 900,
      outlines: [{ color: "#25274D", width: 7 }],
    }));
    const texts = html.match(/<text [^>]*>/g) ?? [];
    expect(texts).toHaveLength(2); // 縁取り 1 層 + 本体
    for (const t of texts) {
      expect(t).toContain("font-weight=\"400\""); // 実際にある face を指定し、足りない太さは線で補う
      expect(t).toContain("font-synthesis-weight:none");
    }
  });

  const render = (props: object) => renderToStaticMarkup(createElement(TextBlock, {
    id: "t", text: "星空", w: 840, h: 143, theme: Object.values(THEMES)[0], size: 100, ...props,
  } as never));
  const sw = 0.012 * 100 * ((900 - 400) / 100); // heavy は 400 だけ、900 指定 → 足す太さ 500

  it("フォントに無い太さは、本体に同じ塗りの線を足し、縁取りの線幅にも足す", () => {
    const html = render({ font: "heavy", weight: 900, outlines: [{ color: "#25274D", width: 7 }] });
    const texts = html.match(/<text [^>]*>/g) ?? [];
    expect(texts[0]).toContain(`stroke-width="${7 * 2 + sw}"`);
    expect(texts[1]).toMatch(/ stroke="[^"]+"/);
    expect(texts[1]).toContain(`stroke-width="${sw}"`);
    expect(texts[1]).toContain("paint-order=\"stroke\"");
  });

  it("フォントが持つ太さでは線を足さない", () => {
    const html = render({ font: "Noto Sans JP", weight: 700, outlines: [{ color: "#25274D", width: 7 }] });
    const texts = html.match(/<text [^>]*>/g) ?? [];
    expect(texts[1]).not.toContain("stroke");
    expect(texts[0]).toContain("stroke-width=\"14\"");
  });

  it("colorRuns の内側 tspan にもその色で線を付ける", () => {
    const html = render({ font: "heavy", weight: 900, colorRuns: [{ start: 0, end: 1, color: "#ff0000" }] });
    expect(html).toMatch(/<tspan[^>]*fill="#ff0000"[^>]*stroke="#ff0000"/);
  });

  it("matchWeight は CSS の照合規則で face を選ぶ", () => {
    const have = [400, 700];
    expect([550, 500, 600, 300, 900].map((w) => matchWeight(have, w))).toEqual([700, 400, 700, 400, 700]);
  });
});

describe("syntheticWeight", () => {
  it("400/700 のフォントは、指定以下で最も太い face に線で足す（600 で 700 に飛ばない）", () => {
    expect(syntheticWeight("BIZ UDPGothic", 500)).toEqual({ face: 400, extra: 100 });
    expect(syntheticWeight("BIZ UDPGothic", 600)).toEqual({ face: 400, extra: 200 });
    expect(syntheticWeight("BIZ UDPGothic", 700)).toEqual({ face: 700, extra: 0 });
    expect(syntheticWeight("BIZ UDPGothic", 900)).toEqual({ face: 700, extra: 200 });
    expect(syntheticWeight("BIZ UDPGothic", 200)).toEqual({ face: 400, extra: 0 });
  });
  it("カタログに無いフォントと範囲外の値", () => {
    expect(syntheticWeight("Unknown Font", 900)).toEqual({ face: 900, extra: 0 });
    expect(syntheticWeight("BIZ UDPGothic", 5000)).toEqual({ face: 400, extra: 0 });
  });
});
