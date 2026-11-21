import { afterEach, describe, expect, it, vi } from "vitest";
import { PosterSpecSchema } from "../src/schema";
import { askAI } from "../server/ai";
import { planPoster } from "../server/planner";

vi.mock("../server/ai", () => ({ askAI: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe("planPoster", () => {
  it("完成見本のファイルなしでスキーマとカタログを使って生成する", async () => {
    const spec = PosterSpecSchema.parse({ meta: { title: "テストのポスター" }, layers: [] });
    vi.mocked(askAI).mockResolvedValue(JSON.stringify(spec));

    await expect(planPoster({ brief: "文化祭のお知らせ", theme: "ocean" })).resolves.toEqual(spec);
    const [system, turns] = vi.mocked(askAI).mock.calls[0];
    expect(system).toContain("# PosterSpec の形式");
    expect(system).toContain("# コンポーネントカタログ");
    expect(system).not.toContain("完成済み PosterSpec の例");
    expect(turns[0].text).toContain("文化祭のお知らせ");
    expect(turns[0].text).toContain('テーマは "ocean"');
  });

  it("画像以外に付いたスクロールはフェードに直す", async () => {
    const sc = { effect: "scroll", direction: "top", scrollTo: 0.5, start: "click", duration: 500, delay: 0 };
    const spec = PosterSpecSchema.parse({ meta: {}, layers: [
      { id: "t", type: "text", text: "a", animation: sc },
      { id: "i", type: "image", src: "/a.png", animation: sc },
    ] });
    vi.mocked(askAI).mockResolvedValue(JSON.stringify(spec));
    const got = await planPoster({ brief: "x" });
    expect(got.layers[0].animation).toMatchObject({ effect: "fade", direction: undefined, scrollTo: undefined });
    expect(got.layers[1].animation).toMatchObject({ effect: "scroll", direction: "top", scrollTo: 0.5 });
  });

  it("{concept, spec} の形式も PosterSpec 直出しも受け付け、concept は捨てる", async () => {
    const spec = PosterSpecSchema.parse({ meta: { title: "文字だけ" }, layers: [{ id: "t", type: "text", text: "a" }] });
    const concept = { images: "なし: 文字だけで見せる", style: "a", grid: "12段・マージン80", sizes: "160/64/32", fonts: "A / B", colors: "白・黒・赤" };
    vi.mocked(askAI).mockResolvedValueOnce(JSON.stringify({ concept, spec }));
    await expect(planPoster({ brief: "x" })).resolves.toEqual(spec);
    vi.mocked(askAI).mockResolvedValueOnce(JSON.stringify(spec));
    await expect(planPoster({ brief: "x" })).resolves.toEqual(spec);
    expect(vi.mocked(askAI)).toHaveBeenCalledTimes(2);
  });

  it("ユーザーターンにデザイン指針とフォント一覧を入れる", async () => {
    vi.mocked(askAI).mockResolvedValue(JSON.stringify(PosterSpecSchema.parse({ meta: {}, layers: [] })));
    await planPoster({ brief: "展覧会のお知らせ" });
    const text = vi.mocked(askAI).mock.calls[0][1][0].text;
    expect(text).toContain("# デザインの進め方");
    expect(text).toContain("タイポグラフィ主役");
    expect(text).toContain("にぎやか・ポップ");
    expect(text).toContain("# 使えるフォント");
    expect(text).toContain('"Noto Sans JP"');
    expect(text).toContain('"concept"');
    expect(text.indexOf("# 使えるフォント")).toBeLessThan(text.indexOf("展覧会のお知らせ"));
  });
});
