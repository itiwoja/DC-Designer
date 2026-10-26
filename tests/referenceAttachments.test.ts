import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReferenceAttachments } from "../src/editor/ReferenceAttachments";

describe("チャットの添付資料", () => {
  it("画像を直接描画せず、画像・PDFページをファイルアイコンと名前で並べる", () => {
    const files = [
      { name: "横長の参考画像.png", url: "data:image/png;base64,large-image" },
      { name: "参考資料.pdf（2ページ目）", url: "data:image/png;base64,pdf-page" },
    ];
    const html = renderToStaticMarkup(createElement(ReferenceAttachments, { files, onRemove: vi.fn() }));

    expect(html).toContain('aria-label="添付した参考資料"');
    expect(html.match(/class="reference-file"/g)).toHaveLength(2);
    expect(html.match(/<svg /g)).toHaveLength(4); // ファイルと削除のアイコン
    for (const file of files) {
      expect(html).toContain(`title="${file.name}"`);
      expect(html).toContain(`aria-label="${file.name} を外す"`);
      expect(html).not.toContain(file.url);
    }
    expect(html).not.toContain("<img");
    expect(html).not.toContain("disabled");
  });

  it("読み込み中・処理中は削除ボタンを無効にできる", () => {
    const html = renderToStaticMarkup(createElement(ReferenceAttachments, {
      files: [{ name: "資料.png" }], disabled: true, onRemove: vi.fn(),
    }));
    expect(html).toContain('disabled=""');
  });

  it("添付がなければ何も表示しない", () => {
    expect(renderToStaticMarkup(createElement(ReferenceAttachments, { files: [], onRemove: vi.fn() }))).toBe("");
  });
});
