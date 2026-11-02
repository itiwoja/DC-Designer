import { describe, expect, it } from "vitest";
import { buildFeedbackUrl, FEEDBACK_MAX_BODY, FEEDBACK_MAX_TITLE } from "../src/editor/feedback";

const get = (url: string, key: string) => new URL(url).searchParams.get(key);
const env = { appVersion: "1.0.7", desktop: true, os: "Windows" };

describe("buildFeedbackUrl", () => {
  it("GitHub の新規 Issue 画面で、labels は付けない", () => {
    const u = new URL(buildFeedbackUrl({ kind: "request", title: "t", body: "b" }));
    expect(u.host).toBe("github.com");
    expect(u.pathname).toBe("/itiwoja/DC-Designer/issues/new");
    expect(u.searchParams.has("labels")).toBe(false);
  });
  it("件名に種類の接頭辞が付く", () => {
    expect(get(buildFeedbackUrl({ kind: "request", title: "色を変えたい", body: "" }), "title")).toBe("[要望] 色を変えたい");
    expect(get(buildFeedbackUrl({ kind: "bug", title: "x", body: "" }), "title")).toBe("[不具合] x");
    expect(get(buildFeedbackUrl({ kind: "question", title: "x", body: "" }), "title")).toBe("[質問] x");
  });
  it("件名が空（空白だけ）ならエラー", () => {
    expect(() => buildFeedbackUrl({ kind: "bug", title: "  ", body: "x" })).toThrow();
  });
  it("env があるときだけ「---」と環境節が付く", () => {
    const without = get(buildFeedbackUrl({ kind: "bug", title: "t", body: "内容" }), "body")!;
    expect(without).toBe("内容");
    const withEnv = get(buildFeedbackUrl({ kind: "bug", title: "t", body: "内容", env }), "body")!;
    expect(withEnv).toContain("内容\n\n---\n環境");
    expect(withEnv).toContain("1.0.7");
    expect(withEnv).toContain("製品版");
    expect(withEnv).toContain("Windows");
    expect(get(buildFeedbackUrl({ kind: "bug", title: "t", body: "", env: { ...env, desktop: false } }), "body")).toContain("開発版");
  });
  it("本文は上限で切り、注記を付ける。環境節は残す", () => {
    const body = get(buildFeedbackUrl({ kind: "bug", title: "t", body: "あ".repeat(FEEDBACK_MAX_BODY * 2), env }), "body")!;
    expect(body.length).toBeLessThanOrEqual(FEEDBACK_MAX_BODY);
    expect(body).toContain("（長いため途中で切りました）");
    expect(body).toContain("Windows");
    const plain = get(buildFeedbackUrl({ kind: "bug", title: "t", body: "a".repeat(FEEDBACK_MAX_BODY + 1) }), "body")!;
    expect(plain.length).toBeLessThanOrEqual(FEEDBACK_MAX_BODY);
    expect(plain.endsWith("（長いため途中で切りました）")).toBe(true);
  });
  it("上限ちょうどなら切らない", () => {
    const body = get(buildFeedbackUrl({ kind: "bug", title: "t", body: "a".repeat(FEEDBACK_MAX_BODY) }), "body")!;
    expect(body).toBe("a".repeat(FEEDBACK_MAX_BODY));
  });
  it("件名は上限で切る", () => {
    const title = get(buildFeedbackUrl({ kind: "request", title: "あ".repeat(500), body: "" }), "title")!;
    expect(title.length).toBe(FEEDBACK_MAX_TITLE);
  });
  it("日本語・改行・& # が往復する", () => {
    const title = "A&B #1 日本語";
    const body = "1行目\n2行目 & 3 # 4\n=?%+";
    const url = buildFeedbackUrl({ kind: "request", title, body });
    expect(get(url, "title")).toBe(`[要望] ${title}`);
    expect(get(url, "body")).toBe(body);
  });
});
