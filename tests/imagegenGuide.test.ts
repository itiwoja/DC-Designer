import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const png = Buffer.from("fake-png").toString("base64");
  return {
    generate: vi.fn(async () => ({ data: [{ b64_json: png }] })),
    edit: vi.fn(async () => ({ data: [{ b64_json: png }] })),
    toFile: vi.fn(async (_b: Buffer, name: string, opts: { type: string }) => ({ name, type: opts.type })),
  };
});
vi.mock("openai", () => ({
  default: class { images = { generate: sdk.generate, edit: sdk.edit }; },
  toFile: sdk.toFile,
}));
vi.mock("../server/secrets", () => ({ getSecret: async () => "sk-test", hasSecret: () => true }));

const root = mkdtempSync(join(tmpdir(), "imagegen-guide-test-"));
process.env.GENERATED_DIR = join(root, "generated");
process.env.IMAGE_PROVIDER = "openai";

let imagegen: typeof import("../server/imagegen");
beforeAll(async () => {
  imagegen = await import("../server/imagegen");
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => vi.clearAllMocks());

const asset = { prompt: "a quiet lake", transparent: false, aspect: "portrait" as const };
const guideA = { mediaType: "image/png", data: Buffer.from("guide-a").toString("base64") };
const guideB = { mediaType: "image/png", data: Buffer.from("guide-b").toString("base64") };

describe("generateAsset の下書き（guide）", () => {
  it("guide が無ければ images.generate、あれば images.edit を呼ぶ", async () => {
    const plain = await imagegen.generateAsset(asset, {}, "openai");
    expect(sdk.generate).toHaveBeenCalledTimes(1);
    expect(sdk.edit).not.toHaveBeenCalled();

    const guided = await imagegen.generateAsset(asset, {}, "openai", undefined, guideA);
    expect(sdk.edit).toHaveBeenCalledTimes(1);
    expect(sdk.generate).toHaveBeenCalledTimes(1);
    const [params] = sdk.edit.mock.calls[0] as any[];
    expect(params.prompt).toMatch(/^The attached image is only a layout sketch/);
    expect(params.prompt).toContain("a quiet lake");
    expect(params.image).toMatchObject({ type: "image/png" });
    expect(params.size).toBe("1024x1536");
    expect(guided.src).not.toBe(plain.src);
  });

  it("キャッシュのキーは下書きの中身で変わり、同じ下書きなら再利用する", async () => {
    const a = await imagegen.generateAsset({ ...asset, prompt: "k1" }, {}, "openai", undefined, guideA);
    const b = await imagegen.generateAsset({ ...asset, prompt: "k1" }, {}, "openai", undefined, guideB);
    const a2 = await imagegen.generateAsset({ ...asset, prompt: "k1" }, {}, "openai", undefined, guideA);
    expect(a.src).not.toBe(b.src);
    expect(a2).toMatchObject({ src: a.src, cached: true });
    expect(sdk.edit).toHaveBeenCalledTimes(2);
  });

  it("透過の素材では下書きを使わず、下書き無しと同じ画像になる", async () => {
    const t = { ...asset, prompt: "sticker", transparent: true };
    const plain = await imagegen.generateAsset(t, {}, "openai");
    const guided = await imagegen.generateAsset(t, {}, "openai", undefined, guideA);
    expect(sdk.edit).not.toHaveBeenCalled();
    expect(guided.src).toBe(plain.src);
  });

  it("下書きを使わないプロバイダ（placeholder）ではキーも変わらない", async () => {
    const plain = await imagegen.generateAsset({ ...asset, prompt: "ph" }, {}, "placeholder");
    const guided = await imagegen.generateAsset({ ...asset, prompt: "ph" }, {}, "placeholder", undefined, guideA);
    expect(guided.src).toBe(plain.src);
  });

  it("gemini では input に画像（data / mime_type）を足す", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ outputs: [{ type: "image", data: Buffer.from("jpg").toString("base64") }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await imagegen.generateAsset({ ...asset, prompt: "gem" }, {}, "gemini", undefined, guideA);
      await imagegen.generateAsset({ ...asset, prompt: "gem2" }, {}, "gemini");
    } finally {
      vi.unstubAllGlobals();
    }
    const body = (i: number) => JSON.parse((fetchMock.mock.calls[i] as any)[1].body);
    expect(body(0).input).toEqual([
      { type: "text", text: expect.stringContaining("layout sketch") },
      { type: "image", data: guideA.data, mime_type: "image/png" },
    ]);
    expect(body(1).input).toHaveLength(1);
  });
});
