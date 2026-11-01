import { describe, expect, it } from "vitest";
import { renderPolicyMarkdown, renderReleaseNotes } from "../../src/lib/markdown.ts";

describe("renderReleaseNotes", () => {
  it("見出し・段落・リスト・リンク・強調・コード・引用を残す", () => {
    const html = renderReleaseNotes(
      "## 変更\n\n* **強い** と *斜体* と `code`\n\n> 引用\n\n[公式](https://example.com/a)\n\n```\nx\n```",
    );
    expect(html).toContain("<h2>変更</h2>");
    expect(html).toContain("<li>");
    expect(html).toContain("<strong>強い</strong>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain("<pre>");
  });
  it("<script> と生 HTML を消す", () => {
    const html = renderReleaseNotes(
      'a<script>alert(1)</script>\n\n<div onclick="x()">生</div>\n\n<img src=x onerror=alert(1)>\n\n<style>p{}</style>',
    );
    expect(html).not.toMatch(/<script|<div|<img|<style|onclick|onerror/);
    // ブロックの <script> は中身ごと消える
    expect(renderReleaseNotes("<script>\nalert(1)\n</script>\n\n本文")).not.toMatch(/script|alert/);
  });
  it("javascript: などのリンクは href を外す", () => {
    const html = renderReleaseNotes(
      "[a](javascript:alert(1)) [b](data:text/html;base64,AAAA) [c](http://example.com) [d](mailto:a@b.c) [e](/relative) [f](#x)",
    );
    expect(html).not.toMatch(/javascript|data:|alert/);
    expect(html).not.toContain("http://example.com");
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain('href="/relative"');
    expect(html).not.toContain('href="#x"');
  });
  it("画像は出さない", () => {
    expect(renderReleaseNotes("![x](https://example.com/a.png)")).not.toContain("<img");
  });
  it("表は許可しない", () => {
    expect(renderReleaseNotes("|a|b|\n|-|-|\n|1|2|")).not.toContain("<table");
  });
  it("素の URL をリンクにし、外部リンクに rel を付ける", () => {
    const html = renderReleaseNotes("in https://github.com/itiwoja/DC-Designer/pull/39");
    expect(html).toContain('href="https://github.com/itiwoja/DC-Designer/pull/39"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe("renderPolicyMarkdown", () => {
  const rewrite = (h: string) => `https://rewritten.example/${h}`;
  it("相対リンクだけ rewriteHref で書き換える", () => {
    const html = renderPolicyMarkdown(
      "[a](./release-policy.md) [b](../SECURITY.md) [c](https://example.com/) [d](#top)",
      rewrite,
    );
    expect(html).toContain('href="https://rewritten.example/./release-policy.md"');
    expect(html).toContain('href="https://rewritten.example/../SECURITY.md"');
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('href="#top"');
  });
  it("サイト内の絶対パスに書き換えたものは残す", () => {
    const html = renderPolicyMarkdown("[p](./privacy.md)", () => "/DC-Designer/privacy/");
    expect(html).toContain('href="/DC-Designer/privacy/"');
  });
  it("表を許可し、危険なものは消す", () => {
    const html = renderPolicyMarkdown(
      "|a|b|\n|-|-|\n|1|2|\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))",
      rewrite,
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).not.toMatch(/<script|javascript|alert/);
  });
  it("//host の形は外す", () => {
    expect(renderPolicyMarkdown("[x](//evil.example/)", (h) => h)).not.toContain("evil.example");
  });
});
