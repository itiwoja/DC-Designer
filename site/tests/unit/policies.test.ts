import { describe, expect, it } from "vitest";
import { buildPolicy, getPolicy, rewritePolicyHref, splitTitle } from "../../src/lib/policies.ts";

describe("rewritePolicyHref", () => {
  it("相対リンクを GitHub の blob URL にする", () => {
    expect(rewritePolicyHref("./release-policy.md", "docs/privacy.md")).toBe(
      "https://github.com/itiwoja/DC-Designer/blob/main/docs/release-policy.md",
    );
    expect(rewritePolicyHref("../SECURITY.md", "docs/privacy.md")).toBe(
      "https://github.com/itiwoja/DC-Designer/blob/main/SECURITY.md",
    );
    expect(rewritePolicyHref("./adr/ADR-005-release-artifact-boundary.md", "docs/code-signing-policy.md")).toBe(
      "https://github.com/itiwoja/DC-Designer/blob/main/docs/adr/ADR-005-release-artifact-boundary.md",
    );
  });
  it("2 文書どうしはサイト内へ", () => {
    expect(rewritePolicyHref("./privacy.md", "docs/code-signing-policy.md")).toBe("/DC-Designer/privacy/");
    expect(rewritePolicyHref("./code-signing-policy.md#x", "docs/privacy.md")).toBe("/DC-Designer/code-signing/#x");
  });
});

describe("splitTitle", () => {
  it("最初の # 見出しを取り出して本文から除く", () => {
    expect(splitTitle("# 題\n\n本文\n## 節")).toEqual({ title: "題", body: "\n本文\n## 節" });
  });
  it("コードブロック内の # は見出しにしない", () => {
    expect(splitTitle("```\n# x\n```\n# 題\nb").title).toBe("題");
  });
  it("見出しが無ければ失敗", () => {
    expect(() => splitTitle("本文だけ")).toThrow();
  });
});

describe("buildPolicy / getPolicy", () => {
  it("本文のリンクを書き換え、見出しを除く", () => {
    const p = buildPolicy("privacy", "# プライバシー\n\n[署名](./code-signing-policy.md) [規約](./release-policy.md)", null);
    expect(p.title).toBe("プライバシー");
    expect(p.bodyHtml).not.toContain("<h1");
    expect(p.bodyHtml).toContain('href="/DC-Designer/code-signing/"');
    expect(p.bodyHtml).toContain("blob/main/docs/release-policy.md");
    expect(p.sourcePath).toBe("docs/privacy.md");
  });
  it("実ファイルを読める", async () => {
    const p = await getPolicy("privacy");
    expect(p.title).toBe("プライバシー");
    expect(p.bodyHtml).toContain("<table>");
    expect(p.bodyHtml).toContain("https://github.com/itiwoja/DC-Designer/blob/main/SECURITY.md");
    const c = await getPolicy("code-signing");
    expect(c.bodyHtml).toContain('href="/DC-Designer/privacy/"');
    expect(c.updatedAt === null || /^\d{4}-\d\d-\d\dT/.test(c.updatedAt)).toBe(true);
  });
});
