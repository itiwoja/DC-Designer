import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// library.ts は読み込み時に保存先を決めるので、環境変数を先に設定してから import する
const root = mkdtempSync(join(tmpdir(), "poster-gen-test-"));
process.env.DATA_DIR = join(root, "data");
process.env.GENERATED_DIR = join(root, "generated");
const lib = await import("../server/library");
const sample = JSON.parse(readFileSync(new URL("../samples/ai-workshop.json", import.meta.url), "utf8"));

const withImage = (src: string) => ({ ...sample, layers: [...sample.layers, { id: "img", type: "image", src, x: 0, y: 0, w: 10, h: 10 }] });

afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  for (const d of lib.listDecks()) lib.deleteDeck(d.id);
  for (const p of lib.listPosters()) lib.deletePoster(p.id);
});

describe("ポスター", () => {
  it("作成・取得・更新・削除できる", () => {
    const p = lib.createPoster(sample);
    expect(lib.getPoster(p.id).spec.meta.title).toBe(sample.meta.title);
    const u = lib.updatePoster(p.id, { ...sample, meta: { ...sample.meta, title: "改題" } });
    expect(u.createdAt).toBe(p.createdAt);
    expect(lib.getPoster(p.id).spec.meta.title).toBe("改題");
    lib.deletePoster(p.id);
    expect(() => lib.getPoster(p.id)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("不正な ID（パス・トラバーサル含む）は 404", () => {
    for (const id of ["../../etc/passwd", "abc", "ABCDEF123456", ""]) {
      expect(() => lib.getPoster(id)).toThrow(expect.objectContaining({ status: 404 }));
    }
  });

  it("スキーマに合わない spec は保存しない", () => {
    expect(() => lib.createPoster({ foo: 1 })).toThrow();
    expect(lib.listPosters()).toHaveLength(0);
  });

  it("複製はタイトルに「のコピー」が付いた別 ID になる", () => {
    const p = lib.createPoster(sample);
    const c = lib.duplicatePoster(p.id);
    expect(c.id).not.toBe(p.id);
    expect(c.spec.meta.title).toBe(`${sample.meta.title} のコピー`);
  });
});

describe("画像ファイル", () => {
  const gen = (name: string) => join(process.env.GENERATED_DIR!, name);

  it("使用中の画像は消さず、未使用だけ消す", () => {
    writeFileSync(gen("used.png"), "x");
    writeFileSync(gen("free.png"), "x");
    writeFileSync(gen("draft.png"), "x");
    const p = lib.createPoster(withImage("/generated/used.png?v=1"));
    expect(lib.listGenerated().find((f) => f.name === "used.png")?.usedBy).toEqual([p.id]);
    // 保存前の編集中 spec が使っている画像も守る
    const deleted = lib.deleteGenerated(["used.png", "free.png", "draft.png"], [withImage("/generated/draft.png")]);
    expect(deleted).toEqual(["free.png"]);
    expect(existsSync(gen("used.png"))).toBe(true);
    expect(existsSync(gen("draft.png"))).toBe(true);
  });

  it("GENERATED_DIR の外は消せない", () => {
    writeFileSync(join(root, "outside.png"), "x");
    expect(lib.deleteGenerated(["../outside.png", "..", ".hidden"])).toEqual([]);
    expect(existsSync(join(root, "outside.png"))).toBe(true);
  });
});

describe("デッキ", () => {
  it("作成するとスライドごとにポスターができる", () => {
    const d = lib.createDeck("発表", [sample, sample]);
    expect(d.slides).toHaveLength(2);
    expect(lib.listPosters()).toHaveLength(2);
    expect(lib.deckOfPoster(d.slides[1].id)?.id).toBe(d.id);
  });

  it("Instagram の投稿は kind を持ち、複製しても引き継ぐ（指定が無ければ持たない）", () => {
    const ig = lib.createDeck("投稿", [sample], "instagram");
    expect(ig.kind).toBe("instagram");
    expect(lib.getDeck(ig.id).kind).toBe("instagram");
    expect(lib.duplicateDeck(ig.id).kind).toBe("instagram");
    expect(lib.createDeck("発表", [sample]).kind).toBeUndefined();
    expect(lib.createDeck("発表", [sample], "bogus").kind).toBeUndefined();
  });

  it("スライドが空なら 400", () => {
    expect(() => lib.createDeck("x", [])).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("after の直後にスライドを追加・複製できる", () => {
    const d = lib.createDeck("発表", [sample, sample]);
    const [a, b] = d.slides.map((s) => s.id);
    const { deck, poster } = lib.addDeckSlide(d.id, { after: a });
    expect(deck.slides.map((s) => s.id)).toEqual([a, poster.id, b]);
    expect(() => lib.addDeckSlide(d.id, {})).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("並べ替えでは既存のスライド以外を混ぜられない", () => {
    const d = lib.createDeck("発表", [sample, sample]);
    const [a, b] = d.slides.map((s) => s.id);
    const u = lib.updateDeck(d.id, { name: "  新名  ", slides: [b, "zzzzzzzzzzzz", a] });
    expect(u.name).toBe("新名");
    expect(u.slides.map((s) => s.id)).toEqual([b, a]);
  });

  it("削除済みのポスターは並びから外れる", () => {
    const d = lib.createDeck("発表", [sample, sample]);
    lib.deletePoster(d.slides[0].id);
    expect(lib.getDeck(d.id).slides.map((s) => s.id)).toEqual([d.slides[1].id]);
  });

  it("デッキを消すとスライドのポスターも消える", () => {
    const d = lib.createDeck("発表", [sample, sample]);
    expect(lib.deleteDeck(d.id)).toHaveLength(2);
    expect(lib.listPosters()).toHaveLength(0);
  });

  it("別のデッキのスライドは削除できず、そのポスターも残る", () => {
    const a = lib.createDeck("A", [sample]);
    const b = lib.createDeck("B", [sample, sample]);
    const bSlides = b.slides.map((s) => s.id);
    expect(() => lib.removeDeckSlide(a.id, bSlides[0])).toThrow(expect.objectContaining({ status: 404 }));
    expect(lib.getPoster(bSlides[0]).id).toBe(bSlides[0]);
    expect(lib.getDeck(b.id).slides.map((s) => s.id)).toEqual(bSlides);
  });

  it("デッキに入っていないポスターは削除できず、ポスターも残る", () => {
    const d = lib.createDeck("発表", [sample]);
    const standalone = lib.createPoster(sample);
    expect(() => lib.removeDeckSlide(d.id, standalone.id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(lib.getPoster(standalone.id).id).toBe(standalone.id);
    expect(lib.getDeck(d.id).slides).toHaveLength(1);
  });

  it("デッキ内のスライドは削除でき、ポスターも消える", () => {
    const d = lib.createDeck("発表", [sample, sample]);
    const [a, b] = d.slides.map((s) => s.id);
    const u = lib.removeDeckSlide(d.id, a);
    expect(u.slides.map((s) => s.id)).toEqual([b]);
    expect(() => lib.getPoster(a)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("並べ替えで同じスライドIDが重複すると 400 で保存されない", () => {
    const d = lib.createDeck("発表", [sample, sample]);
    const [a, b] = d.slides.map((s) => s.id);
    expect(() => lib.updateDeck(d.id, { slides: [a, a] })).toThrow(expect.objectContaining({ status: 400 }));
    expect(lib.getDeck(d.id).slides.map((s) => s.id)).toEqual([a, b]);
  });
});
