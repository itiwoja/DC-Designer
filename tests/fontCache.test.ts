import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FontFetchError, MAX_FONT_BYTES, getFontFace } from "../server/font-cache";

/** OS/2 と name だけを持つ最小の TTF */
export function miniTtf(extra = 0) {
  const b = Buffer.alloc(12 + 32 + 12 + 6 + extra);
  b.writeUInt32BE(0x00010000, 0);
  b.writeUInt16BE(2, 4);
  b.write("OS/2", 12, "latin1");
  b.writeUInt32BE(44, 20);
  b.writeUInt32BE(12, 24);
  b.write("name", 28, "latin1");
  b.writeUInt32BE(56, 36);
  b.writeUInt32BE(6, 40);
  return b;
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const TTF_URL = "https://fonts.gstatic.com/s/notosansjp/v1/a.ttf";
const cssFor = (url: string) => `@font-face { font-family: 'Noto Sans JP'; src: url(${url}) format('truetype'); }`;
const res = (body: BodyInit | Buffer | null, type: string, init: ResponseInit = {}) => new Response(body as BodyInit | null, { ...init, headers: { "content-type": type, ...(init.headers as object) } });

let dir: string;
let calls: string[];
const mockFetch = (handler: (url: string) => Response) => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (u: URL | string) => {
    calls.push(String(u));
    return handler(String(u));
  }));
};
const okHandler = (ttf: Buffer) => (u: string) => (u.startsWith("https://fonts.googleapis.com/") ? res(cssFor(TTF_URL), "text/css; charset=utf-8") : res(ttf, "font/ttf"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fontcache-"));
  process.env.FONT_CACHE_DIR = dir;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FONT_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("フォントの取得とキャッシュ", () => {
  it("取得して検証し、キャッシュに置く。text= は付けない", async () => {
    const ttf = miniTtf();
    mockFetch(okHandler(ttf));
    const f = await getFontFace("Noto Sans JP", 400);
    expect(f).toMatchObject({ fromCache: false, sha256: sha(ttf), byteLength: ttf.length });
    expect(calls.some((c) => c.includes("text="))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["NotoSansJP-400.ttf", "index.json"]);
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    expect(index["NotoSansJP-400"]).toMatchObject({ family: "Noto Sans JP", weight: 400, sha256: sha(ttf), sourceHost: "fonts.gstatic.com" });
  });

  it("キャッシュ命中では通信しない", async () => {
    mockFetch(okHandler(miniTtf()));
    await getFontFace("Noto Sans JP", 400);
    calls.length = 0;
    expect((await getFontFace("Noto Sans JP", 400)).fromCache).toBe(true);
    expect(calls).toEqual([]);
  });

  it("sha256 が index と合わなければ取り直す", async () => {
    const ttf = miniTtf();
    mockFetch(okHandler(ttf));
    await getFontFace("Noto Sans JP", 400);
    writeFileSync(join(dir, "NotoSansJP-400.ttf"), Buffer.from("tampered"));
    calls.length = 0;
    const f = await getFontFace("Noto Sans JP", 400);
    expect(f.fromCache).toBe(false);
    expect(calls.length).toBe(2);
    expect(readFileSync(join(dir, "NotoSansJP-400.ttf")).equals(ttf)).toBe(true);
  });

  it("同時の要求は進行中の取得を共有する", async () => {
    mockFetch(okHandler(miniTtf()));
    await Promise.all([getFontFace("Noto Sans JP", 400), getFontFace("Noto Sans JP", 400)]);
    expect(calls.length).toBe(2);
  });

  it("検証に失敗しても既存の検証済みキャッシュを壊さない", async () => {
    const ttf = miniTtf();
    mockFetch(okHandler(ttf));
    await getFontFace("Noto Sans JP", 400);
    writeFileSync(join(dir, "index.json"), JSON.stringify({}));
    mockFetch(okHandler(Buffer.from("not a font at all")));
    await expect(getFontFace("Noto Sans JP", 400)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(readFileSync(join(dir, "NotoSansJP-400.ttf")).equals(ttf)).toBe(true);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  const rejects = async (code: string) => {
    await expect(getFontFace("Noto Sans JP", 400)).rejects.toMatchObject({ code });
    expect(readdirSync(dir)).toEqual([]);
  };

  it("CSS が許可外ホストを指すと拒否する", async () => {
    mockFetch((u) => (u.includes("googleapis") ? res(cssFor("https://evil.example/a.ttf"), "text/css") : res(miniTtf(), "font/ttf")));
    await rejects("VALIDATION_FAILED");
    expect(calls.length).toBe(1);
  });

  it("http の実体 URL を拒否する", async () => {
    mockFetch((u) => (u.includes("googleapis") ? res(cssFor("http://fonts.gstatic.com/a.ttf"), "text/css") : res(miniTtf(), "font/ttf")));
    await rejects("VALIDATION_FAILED");
  });

  it("リダイレクト先が許可外なら拒否し、追従しない", async () => {
    mockFetch((u) => (u.includes("googleapis") ? res(null, "text/css", { status: 302, headers: { location: "https://evil.example/x" } }) : res(miniTtf(), "font/ttf")));
    await rejects("VALIDATION_FAILED");
    expect(calls.length).toBe(1);
  });

  it("許可内のリダイレクトは 3 回まで", async () => {
    let n = 0;
    mockFetch((u) => {
      if (u.includes("googleapis")) return n++ < 3 ? res(null, "text/css", { status: 302, headers: { location: "/css2?x=1" } }) : res(cssFor(TTF_URL), "text/css");
      return res(miniTtf(), "font/ttf");
    });
    await expect(getFontFace("Noto Sans JP", 400)).resolves.toBeTruthy();
    n = -1;
    mockFetch(() => res(null, "text/css", { status: 302, headers: { location: "/loop" } }));
    await expect(getFontFace("Noto Sans JP", 700)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(calls.length).toBe(4);
  });

  it("Content-Type が不正なら拒否する", async () => {
    mockFetch((u) => (u.includes("googleapis") ? res(cssFor(TTF_URL), "text/html") : res(miniTtf(), "font/ttf")));
    await rejects("VALIDATION_FAILED");
    mockFetch((u) => (u.includes("googleapis") ? res(cssFor(TTF_URL), "text/css") : res(miniTtf(), "text/html")));
    await rejects("VALIDATION_FAILED");
  });

  it("外部 @import を含む CSS を拒否する", async () => {
    mockFetch(() => res(`@import url(https://evil.example/a.css);${cssFor(TTF_URL)}`, "text/css"));
    await rejects("VALIDATION_FAILED");
  });

  it("32MiB を超える実体を拒否する", async () => {
    mockFetch(okHandler(Buffer.alloc(MAX_FONT_BYTES + 1)));
    await rejects("VALIDATION_FAILED");
  });

  it("壊れた sfnt を拒否する", async () => {
    mockFetch(okHandler(Buffer.from("wOFF....................")));
    await rejects("VALIDATION_FAILED");
    const broken = miniTtf();
    broken.writeUInt16BE(0, 4); // テーブルが無い
    mockFetch(okHandler(broken));
    await rejects("VALIDATION_FAILED");
  });

  it("HTTP エラーと接続失敗は NETWORK_FAILED", async () => {
    mockFetch(() => res("x", "text/plain", { status: 500 }));
    await rejects("NETWORK_FAILED");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fail"); }));
    await rejects("NETWORK_FAILED");
    expect(new FontFetchError("NETWORK_FAILED", "x").code).toBe("NETWORK_FAILED");
  });
});
