import { describe, expect, it } from "vitest";
import {
  buildCsp, inlineScriptHashes, isAllowedRequestUrl, isAppUrl, isExternalHttpsUrl, resolveAppTarget, resolveUnder, targetFilePath,
} from "../desktop/appProtocol";
import { DESKTOP_OPERATIONS, resolveDesktopRequest } from "../desktop/operations";

const A = "app://dc-designer";

describe("resolveAppTarget", () => {
  it("/ は index.html、dist の資源はそのまま解決する", () => {
    expect(resolveAppTarget(`${A}/`)).toMatchObject({ kind: "dist", segments: ["index.html"] });
    expect(resolveAppTarget(`${A}/assets/index-abc.js?x=1`)).toMatchObject({ kind: "dist", segments: ["assets", "index-abc.js"], type: expect.stringContaining("javascript") });
    expect(resolveAppTarget(`${A}/assets/pdf.worker.min-x.mjs`)).toMatchObject({ kind: "dist" });
  });

  it("無い path を index.html に落とさない（拡張子のない path・末尾 / は拒否）", () => {
    expect(resolveAppTarget(`${A}/editor`)).toBeNull();
    expect(resolveAppTarget(`${A}/assets/`)).toBeNull();
  });

  it("..・%2e%2e・区切りのエンコード・絶対 path・ドライブ指定を拒否する", () => {
    for (const p of [
      "/../secret.js", "/assets/../../x.js", "/%2e%2e/x.js", "/assets/%2e%2e/%2e%2e/x.js", "/assets/..%2fx.js",
      "/assets/%5cx.js", "/assets/..%5cx.js", "/C:/x.js", "/assets/c%3Ax.js", "/%00.js", "/assets/%zz.js",
    ]) {
      const t = resolveAppTarget(`${A}${p}`);
      // URL パーサが正規化して dist 内の別 path になる場合は dist の外へ出ないことだけ確かめる
      if (t) expect(targetFilePath(t, { dist: "/app/dist", pdfAssets: "/app/pdf", generated: "/u/gen" })?.startsWith("/app/dist/") ?? true).toBe(true);
    }
    for (const p of ["/assets/%2e%2e%2fx.js", "/assets/..%2fx.js", "/assets/%5cx.js", "/assets/c%3Ax.js", "/%00.js", "/assets/%zz.js", "/assets/a b.js"]) {
      expect(resolveAppTarget(`${A}${p}`)).toBeNull();
    }
  });

  it("別 host・別 scheme・userinfo・port を拒否する", () => {
    expect(resolveAppTarget("app://evil/")).toBeNull();
    expect(resolveAppTarget("app://DC-Designer/")).toBeNull();
    expect(resolveAppTarget("https://dc-designer/")).toBeNull();
    expect(resolveAppTarget("file:///etc/passwd")).toBeNull();
    expect(resolveAppTarget("app://user@dc-designer/")).toBeNull();
    expect(resolveAppTarget("app://dc-designer:8080/")).toBeNull();
    expect(resolveAppTarget("not a url")).toBeNull();
  });

  it("許可しない拡張子を拒否する（.map・.exe・拡張子なし）", () => {
    for (const p of ["/assets/a.map", "/assets/a.exe", "/assets/noext", "/.env", "/assets/.hidden"]) {
      expect(resolveAppTarget(`${A}${p}`)).toBeNull();
    }
  });

  it("PDF.js 同梱資源は dir ごとの拡張子だけ", () => {
    expect(resolveAppTarget(`${A}/api/pdf-assets/cmaps/UniJIS-UTF16-H.bcmap`)).toMatchObject({ kind: "pdf", dir: "cmaps" });
    expect(resolveAppTarget(`${A}/api/pdf-assets/standard_fonts/FoxitSans.pfb`)).toMatchObject({ kind: "pdf" });
    expect(resolveAppTarget(`${A}/api/pdf-assets/wasm/openjpeg.wasm`)).toMatchObject({ kind: "pdf", type: "application/wasm" });
    expect(resolveAppTarget(`${A}/api/pdf-assets/cmaps/x.wasm`)).toBeNull();
    expect(resolveAppTarget(`${A}/api/pdf-assets/other/x.wasm`)).toBeNull();
    expect(resolveAppTarget(`${A}/api/pdf-assets/wasm/sub/x.wasm`)).toBeNull();
    expect(resolveAppTarget(`${A}/api/posters`)).toBeNull();
    expect(resolveAppTarget(`${A}/api/status`)).toBeNull();
  });

  it("generated は安全なファイル名と画像・音声の拡張子だけ", () => {
    expect(resolveAppTarget(`${A}/generated/abc-1.png`)).toEqual({ kind: "generated", file: "abc-1.png", type: "image/png" });
    expect(resolveAppTarget(`${A}/generated/a.MP3`)).toMatchObject({ type: "audio/mpeg" });
    for (const p of ["/generated/a.html", "/generated/a.js", "/generated/x", "/generated/", "/generated/a/b.png", "/generated/..%2fa.png", "/generated/a..b.png"]) {
      expect(resolveAppTarget(`${A}${p}`)).toBeNull();
    }
  });
});

describe("path / URL 判定", () => {
  it("resolveUnder は root の外へ出ない", () => {
    expect(resolveUnder("/app/dist", "assets", "a.js")).toBe("/app/dist/assets/a.js");
    expect(resolveUnder("/app/dist", "..", "x")).toBeNull();
    expect(resolveUnder("/app/dist", "../dist-evil/x")).toBeNull();
  });

  it("isAppUrl / isAllowedRequestUrl / isExternalHttpsUrl", () => {
    expect(isAppUrl("app://dc-designer/")).toBe(true);
    expect(isAppUrl("app://dc-designer.evil.com/")).toBe(false);
    expect(isAppUrl("https://dc-designer/")).toBe(false);
    for (const u of ["app://dc-designer/x", "data:text/plain,a", "blob:app://dc-designer/1", "devtools://devtools/a"]) expect(isAllowedRequestUrl(u)).toBe(true);
    for (const u of ["https://example.com/", "http://127.0.0.1:3000/", "file:///a", "ws://x/", "app://other/", "wss://x"]) expect(isAllowedRequestUrl(u)).toBe(false);
    expect(isExternalHttpsUrl("https://github.com/itiwoja")).toBe(true);
    for (const u of ["http://a.com", "file:///a", "javascript:alert(1)", "https://u:p@a.com", "mailto:a@b.c"]) expect(isExternalHttpsUrl(u)).toBe(false);
  });
});

describe("CSP", () => {
  it("inline script のハッシュだけ足し、外部 src は足さない", () => {
    const html = `<script>var a=1;</script><script type="module" src="/a.js"></script><script> </script>`;
    const h = inlineScriptHashes(html);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    expect(buildCsp(h)).toContain(`script-src 'self' 'wasm-unsafe-eval' ${h[0]}`);
    expect(buildCsp()).toContain("frame-src 'none'");
  });
});

describe("resolveDesktopRequest の境界", () => {
  const id = "abcdefghij12";
  it("正しい要求は相対 path になる", () => {
    expect(resolveDesktopRequest({ operation: "posters.get", params: { id } })?.path).toBe(`/api/posters/${id}`);
    expect(resolveDesktopRequest({ operation: "posters.deck", params: { id }, query: { specs: "1" } })?.path).toBe(`/api/posters/${id}/deck?specs=1`);
    expect(resolveDesktopRequest({ operation: "posters.create", body: { a: 1 } })?.op).toBe(DESKTOP_OPERATIONS["posters.create"]);
  });
  it("不正な形は null", () => {
    for (const r of [
      null, "x", {}, { operation: "ai.generate" }, { operation: "__proto__" }, { operation: "posters.get" },
      { operation: "posters.get", params: { id: "../etc" } }, { operation: "posters.get", params: { id, extra: "a" } },
      { operation: "posters.get", params: { id }, query: { x: "1" } }, { operation: "posters.deck", params: { id }, query: { specs: "2" } },
      { operation: "posters.get", params: { id }, body: {} }, { operation: "status.get", url: "http://x" },
      { operation: "posters.list", params: [] }, { operation: "posters.get", params: { id: 1 } },
    ]) expect(resolveDesktopRequest(r)).toBeNull();
  });
});
