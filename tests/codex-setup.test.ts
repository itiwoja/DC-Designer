import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PinnedCodexAsset } from "../server/codex-pinned";
import type { SetupProgress } from "../server/codex-setup";

const root = mkdtempSync(join(tmpdir(), "codex-setup-test-"));
process.env.GENERATED_DIR = join(root, "generated");
process.env.DC_DESIGNER_DESKTOP = "1";

type Setup = typeof import("../server/codex-setup");
type Settings = typeof import("../server/image-settings");
let setup: Setup;
let settings: Settings;
beforeAll(async () => {
  setup = await import("../server/codex-setup");
  settings = await import("../server/image-settings");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
let userRoot = "";
beforeEach(() => {
  const dir = join(root, `case${++n}`);
  userRoot = join(dir, "userroot");
  mkdirSync(join(dir, "workspace"), { recursive: true });
  mkdirSync(join(dir, "user-codex"), { recursive: true });
  process.env.DATA_DIR = join(dir, "workspace");
  process.env.CODEX_HOME = join(dir, "user-codex");
  process.env.DC_DESIGNER_USER_ROOT = userRoot;
});

// ---- tar.gz を作る ----
function tarHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000755\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function tarGz(entries: { name: string; data: Buffer; type?: string }[]): Buffer {
  const parts = entries.flatMap((e) => [tarHeader(e.name, e.data.length, e.type ?? "0"), pad(e.data)]);
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

// 圧縮が効かない中身にして、ダウンロードが何回かに分かれて届くようにする
const EXE = Buffer.concat([Buffer.from("MZ-fake-codex-"), randomBytes(300_000)]);
const ENTRY = "codex-x86_64-pc-windows-msvc.exe";
const archive = tarGz([
  { name: "PaxHeaders/x", data: Buffer.from("30 path=something-long-name\n"), type: "x" },
  { name: "README.txt", data: Buffer.from("not this one") },
  { name: ENTRY, data: EXE },
]);
const assetFor = (buf: Buffer, over: Partial<PinnedCodexAsset> = {}): PinnedCodexAsset => ({
  name: "codex-x86_64-pc-windows-msvc.exe.tar.gz", size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), entry: ENTRY, ...over,
});

/** 偽の fetch：github.com は転送（302）、転送先は本体を小分けに流す。呼ばれた URL を記録する */
function fakeFetch(body: Buffer, opts: { location?: string; onChunk?: (i: number) => void } = {}) {
  const calls: string[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect(init?.redirect).toBe("manual");
    if (url.startsWith("https://github.com/")) {
      return new Response(null, { status: 302, headers: { location: opts.location ?? "https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=x" } });
    }
    let i = 0;
    const size = 64 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (init?.signal?.aborted) { c.error(init.signal.reason); return; }
        const chunk = body.subarray(i * size, (i + 1) * size);
        if (!chunk.length) { c.close(); return; }
        opts.onChunk?.(i);
        i++;
        c.enqueue(new Uint8Array(chunk));
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const run = (deps: Parameters<Setup["installCodex"]>[2], signal = new AbortController().signal) => {
  const progress: SetupProgress[] = [];
  return { progress, promise: setup.installCodex((p) => progress.push(p), signal, deps) };
};

describe("installCodex", () => {
  it("転送先を検証してから取り、sha256 が一致したら tar の中の実行ファイルだけを版のフォルダに置く", async () => {
    const f = fakeFetch(archive);
    const { progress, promise } = run({ fetch: f.fn, asset: assetFor(archive) });
    const r = await promise;
    const exe = settings.appCodexExe()!;
    expect(r).toEqual({ path: exe, version: "0.166.0", signedIn: false });
    expect(readFileSync(exe)).toEqual(EXE);
    expect(readdirSync(dirname(exe))).toEqual(["codex"]); // 書きかけのファイルは残らない
    expect(f.calls[0]).toBe("https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-x86_64-pc-windows-msvc.exe.tar.gz");
    expect(f.calls[1]).toMatch(/^https:\/\/release-assets\.githubusercontent\.com\//);
    const steps = progress.map((p) => p.step);
    expect(steps[0]).toBe("download");
    expect(steps.slice(-2)).toEqual(["verify", "install"]);
    expect(progress.filter((p) => p.step === "download").at(-1)).toEqual({ phase: "setup", step: "download", done: archive.length, total: archive.length });
  });

  it("サインイン済みなら signedIn: true、すでに入っていれば取りに行かない", async () => {
    writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), "{}");
    await run({ fetch: fakeFetch(archive).fn, asset: assetFor(archive) }).promise;
    const again = fakeFetch(archive);
    const r = await run({ fetch: again.fn, asset: assetFor(archive) }).promise;
    expect(r.signedIn).toBe(true);
    expect(again.calls).toEqual([]);
  });

  it("sha256 が違えば入れない（codex_verify_failed）", async () => {
    const { promise } = run({ fetch: fakeFetch(archive).fn, asset: assetFor(archive, { sha256: "0".repeat(64) }) });
    await expect(promise).rejects.toMatchObject({ code: "codex_verify_failed" });
    const exe = settings.appCodexExe()!;
    expect(existsSync(exe)).toBe(false);
    expect(readdirSync(dirname(exe))).toEqual([]);
  });

  it("想定より大きなファイルが届いたら止める", async () => {
    const { promise } = run({ fetch: fakeFetch(archive).fn, asset: assetFor(archive, { size: 1000 }) });
    await expect(promise).rejects.toMatchObject({ code: "codex_verify_failed" });
  });

  it("tar の中に実行ファイルが無ければ入れない", async () => {
    const other = tarGz([{ name: "README.txt", data: Buffer.from("x") }]);
    await expect(run({ fetch: fakeFetch(other).fn, asset: assetFor(other) }).promise).rejects.toMatchObject({ code: "codex_verify_failed" });
  });

  it("想定外の転送先には取りに行かない", async () => {
    const f = fakeFetch(archive, { location: "https://evil.example.com/codex.tar.gz" });
    await expect(run({ fetch: f.fn, asset: assetFor(archive) }).promise).rejects.toMatchObject({ code: "codex_download_failed" });
    expect(f.calls).toHaveLength(1);
  });

  it("途中で中止したら書きかけのファイルを消す", async () => {
    const ac = new AbortController();
    const f = fakeFetch(archive, { onChunk: (i) => { if (i === 1) ac.abort(); } });
    await expect(run({ fetch: f.fn, asset: assetFor(archive) }, ac.signal).promise).rejects.toBeTruthy();
    const exe = settings.appCodexExe()!;
    expect(existsSync(exe)).toBe(false);
    expect(readdirSync(dirname(exe))).toEqual([]);
  });

  it("Windows の x64 / arm64 以外は入れられない", async () => {
    await expect(run({ fetch: fakeFetch(archive).fn, platform: "win32", arch: "ia32" }).promise).rejects.toMatchObject({ code: "codex_install_unsupported" });
    await expect(run({ fetch: fakeFetch(archive).fn, platform: "darwin", arch: "arm64" }).promise).rejects.toMatchObject({ code: "codex_install_unsupported" });
  });

  it("入れ終えたら、設定に残っている存在しないパスを消す", async () => {
    settings.updateImageSettings({ codexPath: join(root, "nowhere", "codex") });
    await run({ fetch: fakeFetch(archive).fn, asset: assetFor(archive) }).promise;
    expect(settings.readImageSettings().codexPath).toBe("");
  });
});
