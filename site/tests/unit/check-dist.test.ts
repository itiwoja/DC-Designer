// dist の検査ロジックの単体テスト（scripts/check-dist.mjs）
import { describe, expect, it } from "vitest";
import { checkHtml, EXE_PREFIX } from "../../scripts/check-dist.mjs";

const CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'";
const page = (head = "", body = "") =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}">${head}</head><body>${body}</body></html>`;

const run = (file: string, html: string): string[] => checkHtml(file, html);
const has = (problems: string[], word: string) => problems.some((p) => p.includes(word));

describe("checkHtml", () => {
  it("違反の無いページは通る", () => {
    const html = page('<link rel="stylesheet" href="/DC-Designer/_astro/a.css"><script type="module" src="/DC-Designer/_astro/a.js"></script>', "<p>x</p>");
    expect(run("index.html", html)).toEqual([]);
  });

  it("src の無い <script> を type を問わず検出する", () => {
    expect(has(run("index.html", page("", "<script>alert(1)</script>")), "<script>")).toBe(true);
    expect(has(run("index.html", page("", '<script type="module">import "x"</script>')), "<script>")).toBe(true);
    expect(has(run("index.html", page("", '<script type="application/ld+json">{}</script>')), "<script>")).toBe(true);
  });

  it("<style> と style 属性を検出する", () => {
    expect(has(run("index.html", page("<style>a{}</style>")), "<style>")).toBe(true);
    expect(has(run("index.html", page("", '<p style="color:red">x</p>')), "style 属性")).toBe(true);
    expect(has(run("index.html", page("", "<p style='a>b'>x</p>")), "style 属性")).toBe(true);
  });

  it("コメントの中は検査しない", () => {
    expect(run("index.html", page("", "<!-- <script>x</script> -->"))).toEqual([]);
  });

  it("CSP の meta が無いと検出する", () => {
    expect(has(run("index.html", "<html><head></head><body></body></html>"), "Content-Security-Policy")).toBe(true);
  });

  it("CSP の指令が欠けると検出する", () => {
    const weak = page().replace("; form-action 'none'", "").replace("img-src 'self' data:", "img-src 'self'");
    const problems = run("index.html", weak);
    expect(has(problems, "form-action")).toBe(true);
    expect(has(problems, "img-src に data:")).toBe(true);
  });

  it("外部オリジンの script・stylesheet を検出する", () => {
    const problems = run(
      "index.html",
      page('<script src="https://example.com/a.js"></script><link rel="stylesheet" href="//fonts.example/x.css">'),
    );
    expect(has(problems, "外部オリジンの <script>")).toBe(true);
    expect(has(problems, "外部オリジンのスタイルシート")).toBe(true);
  });

  it("外部への通常のリンクや preload 以外の link は許す", () => {
    expect(run("index.html", page('<link rel="canonical" href="https://itiwoja.github.io/DC-Designer/">', '<a href="https://github.com/x">x</a>'))).toEqual([]);
  });

  it("404.html は資産を /DC-Designer/ か https: の絶対参照にする", () => {
    const ok = page('<link rel="stylesheet" href="/DC-Designer/_astro/a.css">', '<a href="/DC-Designer/">トップ</a><a href="https://github.com/">g</a>');
    expect(run("404.html", ok)).toEqual([]);
    const ng = page('<link rel="stylesheet" href="_astro/a.css">', '<a href="/download/">d</a>');
    const problems = run("404.html", ng);
    expect(problems.filter((p) => p.includes("404.html"))).toHaveLength(2);
    // 他のページには課さない
    expect(run("index.html", ng)).toEqual([]);
  });

  it("download/index.html の exe リンクは版つき Releases の URL にする", () => {
    const ok = page("", `<a href="${EXE_PREFIX}1.0.6/DC-Designer-Setup-1.0.6.exe">DL</a>`);
    expect(run("download/index.html", ok)).toEqual([]);
    const ng = page("", '<a href="https://example.com/DC-Designer-Setup-1.0.6.exe">DL</a>');
    expect(has(run("download/index.html", ng), "exe のリンク")).toBe(true);
    expect(has(run("download/index.html", page("", "<p>x</p>")), "exe へのリンクがありません")).toBe(true);
  });
});
