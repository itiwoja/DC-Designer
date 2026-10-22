import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseReferences, storeReferences, referenceSources, resolveReferenceSources } from "../server/references";
import { MAX_REFERENCE_DATA_BYTES } from "../src/referenceLimits";
import { api } from "../src/editor/api";
import { PosterSpecSchema } from "../src/schema";

const ai = vi.hoisted(() => ({ ask: vi.fn() }));
const storage = vi.hoisted(() => ({ save: vi.fn((mediaType: string, data: string) => ({ src: `/generated/saved-${data}.png` })) }));
vi.mock("../server/chatgpt", async (original) => ({ ...await original<typeof import("../server/chatgpt")>(), askChatGPT: ai.ask }));
vi.mock("../server/imagegen", () => ({ saveUpload: storage.save }));
import { editPoster, planPoster } from "../server/planner";

const spec = PosterSpecSchema.parse({ meta: { title: "添付のテスト", width: 1000, height: 1414 }, theme: "ocean", layers: [] });
const references = [{ mediaType: "image/jpeg" as const, data: "YWJj" }, { mediaType: "image/png" as const, data: "ZGVm" }];
beforeEach(() => { ai.ask.mockReset().mockResolvedValue('{"reply":"確認した","spec":null}'); storage.save.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

describe("添付資料の検証", () => {
  it("添付なしと正しい画像配列を受け付ける", () => {
    expect(parseReferences(undefined)).toBeUndefined();
    expect(parseReferences(references)).toEqual(references);
  });
  it.each([null, {}, [{ mediaType: "application/pdf", data: "YWJj" }], [{ mediaType: "image/jpeg", data: "bad!" }], Array(21).fill(references[0])])("不正な添付を拒否する: %j", (value) => {
    expect(() => parseReferences(value)).toThrow("画像形式で 20 枚まで");
  });
  it("合計サイズ超過を拒否する", () => {
    expect(() => parseReferences([{ ...references[0], data: "A".repeat(MAX_REFERENCE_DATA_BYTES + 1) }])).toThrow("合計サイズ");
  });
});

describe("添付画像を実際の保存URLで配置する", () => {
  const saved = references.map((r, i) => ({ ...r, name: i ? "1792492556855.png" : "image.png", src: `/generated/actual-${i}.png` }));
  const image = (id: string, src: string) => ({ id, type: "image", src, x: 0, y: 0, w: 100, h: 100, fit: "contain", asset: { prompt: "user-provided image", transparent: false, aspect: "landscape" } });
  const withImages = () => PosterSpecSchema.parse({ ...spec, layers: [image("user-image-1", "image.png"), image("user-image-2", "1792492556855.png")] });

  it("元のファイル名と画像データを保存し、生成されたURLを参照一覧に含める", () => {
    const stored = storeReferences([{ ...references[0], name: "image.png" }]);
    expect(storage.save).toHaveBeenCalledWith("image/jpeg", "YWJj");
    expect(stored?.[0]).toMatchObject({ name: "image.png", src: "/generated/saved-YWJj.png" });
    expect(referenceSources(stored)).toContain("/generated/saved-YWJj.png");
  });

  it("今回の壊れたファイル名を保存済みURLへ直し、不要な生成指示を消す", () => {
    const before = withImages();
    const after = resolveReferenceSources(before, saved);
    expect(after.layers.map((l) => l.type === "image" && l.src)).toEqual(saved.map((r) => r.src));
    expect(after.layers.every((l) => !("asset" in l))).toBe(true);
    expect(before.layers[0]).toMatchObject({ src: "image.png" });
  });

  it("添付の番号で特定できる画像も正しいURLに戻す", () => {
    const result = resolveReferenceSources(PosterSpecSchema.parse({ ...spec, layers: [image("user-image-2", "invented.png")] }), saved);
    expect(result.layers[0]).toMatchObject({ src: saved[1].src });
  });

  it("既存画像を保ち、添付と特定できない新規の架空ファイル名は拒否する", () => {
    const previous = PosterSpecSchema.parse({ ...spec, layers: [image("old", "old.png")] });
    expect(resolveReferenceSources(previous, undefined, previous).layers[0]).toMatchObject({ src: "old.png" });
    expect(() => resolveReferenceSources(PosterSpecSchema.parse({ ...spec, layers: [image("new", "invented.png")] }), saved, spec)).toThrow("保存済みURLではありません");
  });

  it.each([false, true])("通常編集・デッキ編集ともURLを提示し、返されたファイル名を修復する（デッキ:%s）", async (deck) => {
    ai.ask.mockResolvedValue(JSON.stringify({ reply: "配置した", spec: withImages(), target: 1 }));
    const result = await editPoster({ spec, instruction: "添付画像を入れて", references: saved, ...(deck ? { deck: { current: 1, total: 1, slides: [] } } : {}) });
    expect(ai.ask.mock.calls[0][1][0].text).toContain(saved[0].src);
    expect(result.spec?.layers[0]).toMatchObject({ src: saved[0].src });
  });

  it("新規生成でも添付画像を実URLで配置する", async () => {
    ai.ask.mockResolvedValue(JSON.stringify(withImages()));
    const result = await planPoster({ brief: "画像を入れて", references: saved });
    expect(ai.ask.mock.calls[0][1][0].text).toContain(saved[1].src);
    expect(result.layers[1]).toMatchObject({ src: saved[1].src });
  });
});

describe("AIへの添付受け渡し", () => {
  it.each([false, true])("通常編集・デッキ編集とも全ページを順番に渡す（デッキ: %s）", async (deck) => {
    await editPoster({ spec, instruction: "添付資料を参考にして", references, ...(deck ? { deck: { current: 1, total: 1, slides: [] } } : {}) });
    expect(ai.ask.mock.calls[0][1][0].images).toEqual(references);
  });
  it("添付なしの既存編集も動作する", async () => {
    expect(await editPoster({ spec, instruction: "タイトルを確認して" })).toEqual({ reply: "確認した" });
  });
  it("クライアントがPDFページをAPI本文に含める", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"reply":"確認した"}', { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.edit(spec, "資料を確認して", undefined, undefined, undefined, undefined, undefined, undefined, references);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).references).toEqual(references);
  });
});
