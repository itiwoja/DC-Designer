import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextBlock } from "../src/render/TextBlock";
import { THEMES } from "../src/themes";

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
      expect(t).toContain("font-weight=\"900\"");
      expect(t).toContain("font-synthesis-weight:none");
    }
  });
});
