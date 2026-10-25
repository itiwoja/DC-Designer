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
});
