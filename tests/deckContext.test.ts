import { beforeEach, describe, expect, it, vi } from "vitest";
import { PosterSpecSchema } from "../src/schema";

const ai = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("../server/chatgpt", async (original) => ({ ...await original<typeof import("../server/chatgpt")>(), askChatGPT: ai.ask }));
import { editPoster } from "../server/planner";

const spec = (title: string) => PosterSpecSchema.parse({ meta: { title, width: 1000, height: 1414 }, theme: "ocean", layers: [] });
const current = spec("今のスライド");
beforeEach(() => { ai.ask.mockReset().mockResolvedValue('{"reply":"確認した","spec":null}'); });

describe("デッキの文脈（言及したスライドは全体、ほかは文字だけ）", () => {
  it("文字だけのスライドは参考として渡し、書き換え先の候補にしない", async () => {
    await editPoster({
      spec: current, instruction: "スライド3の内容を今のスライドに反映して",
      deck: { current: 1, total: 3, slides: [
        { number: 2, title: "二", texts: ["二枚目の本文"] },
        { number: 3, title: "三", spec: spec("三枚目") },
      ] },
    });
    const prompt: string = ai.ask.mock.calls[0][1][0].text;
    expect(prompt).toContain("# スライド 2「二」（文字だけの参考。書き換え・統合の対象にはしない）\n二枚目の本文");
    expect(prompt).toContain("# スライド 3「三」");
    expect(prompt).not.toContain("# スライド 2「二」\n{");
  });

  it("文字だけのスライドを書き換え先にした返答は受け付けない", async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ reply: "直した", spec: PosterSpecSchema.parse({ meta: { title: "直後", width: 1000, height: 1414 }, theme: "ocean", layers: [] }), target: 2, remove: [] }));
    await expect(editPoster({
      spec: current, instruction: "スライド2を直して",
      deck: { current: 1, total: 2, slides: [{ number: 2, title: "二", texts: ["本文"] }] },
    })).rejects.toThrow("target は 1 のいずれかにしてください");
  });

  it("参考スライドの theme と配色は「配色」の行として渡す（無ければ出さない）", async () => {
    await editPoster({
      spec: current, instruction: "ほかのスライドと色を合わせて",
      deck: { current: 1, total: 2, slides: [{ number: 2, title: "二", texts: ["本文"], theme: "ocean", colors: ["#fff", "$primary"] }] },
    });
    expect(ai.ask.mock.calls[0][1][0].text).toContain("本文\n配色: テーマ ocean / よく使う色 #fff, $primary\n");
    ai.ask.mockClear();
    await editPoster({
      spec: current, instruction: "スライド2を直して",
      deck: { current: 1, total: 2, slides: [{ number: 2, title: "二", texts: ["本文"] }] },
    });
    expect(ai.ask.mock.calls[0][1][0].text).not.toContain("\n配色: ");
  });

  it("文字だけのスライドの台本も参考として渡す", async () => {
    await editPoster({
      spec: current, instruction: "台本の流れを確認して",
      deck: { current: 1, total: 2, slides: [{ number: 2, title: "二", texts: ["本文"], notes: "次に二つ目の話です" }] },
    });
    expect(ai.ask.mock.calls[0][1][0].text).toContain("本文\n台本: 次に二つ目の話です");
  });

  it("複数のスライドを一度に書き換えられる（今のスライドを主にし、ほかは others に入れる）", async () => {
    const edited = (title: string, notes: string) => ({ ...spec(title), notes });
    ai.ask.mockResolvedValue(JSON.stringify({ reply: "台本をそろえた", edits: [{ target: 3, spec: edited("三", "三の台本") }, { target: 1, spec: edited("一", "一の台本") }], remove: [] }));
    const r = await editPoster({
      spec: current, instruction: "1枚目と3枚目の台本の整合性を持たせて",
      deck: { current: 1, total: 3, slides: [{ number: 3, title: "三", spec: spec("三枚目") }] },
    });
    expect(r.target).toBe(1);
    expect(r.spec?.notes).toBe("一の台本");
    expect(r.others?.map((e) => [e.target, e.spec.notes])).toEqual([[3, "三の台本"]]);
  });

  it("edits の spec が null の件は変更なしとして読み飛ばす", async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ reply: "3枚目だけ直した", edits: [{ target: 1, spec: null }, { target: 3, spec: spec("直後") }], remove: [] }));
    const r = await editPoster({
      spec: current, instruction: "1枚目と3枚目を見直して",
      deck: { current: 1, total: 3, slides: [{ number: 3, title: "三", spec: spec("三枚目") }] },
    });
    expect(ai.ask).toHaveBeenCalledTimes(1);
    expect(r.target).toBe(3);
    expect(r.others).toBeUndefined();
  });

  it("PosterSpec そのものの返答は今のスライドの書き換えとして受け付ける", async () => {
    ai.ask.mockResolvedValue(JSON.stringify(spec("直後")));
    const r = await editPoster({
      spec: current, instruction: "スライド2を参考に直して",
      deck: { current: 1, total: 2, slides: [{ number: 2, title: "二", spec: spec("二枚目") }] },
    });
    expect(ai.ask).toHaveBeenCalledTimes(1);
    expect(r.target).toBe(1);
    expect(r.spec?.meta.title).toBe("直後");
  });

  it("古い形式（target と spec）の返答も受け付ける", async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ reply: "直した", target: 2, spec: spec("直後"), remove: [] }));
    const r = await editPoster({
      spec: current, instruction: "スライド2を直して",
      deck: { current: 1, total: 2, slides: [{ number: 2, title: "二", spec: spec("二枚目") }] },
    });
    expect(r.target).toBe(2);
    expect(r.others).toBeUndefined();
  });

  it("構成を変える指示では sequence が応答に載り、新規スライドの spec も検証される", async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ reply: "2枚目を分けた", edits: [{ target: 2, spec: spec("二の前半") }], sequence: [1, 2, { spec: spec("二の後半") }, 3] }));
    const r = await editPoster({
      spec: current, instruction: "2枚目を2枚に分けて",
      deck: { current: 1, total: 3, selected: [2], slides: [{ number: 2, title: "二", spec: spec("二") }, { number: 3, title: "三", texts: ["本文"] }] },
    });
    expect(ai.ask.mock.calls[0][1][0].text).toContain("ユーザーがスライド一覧で選択中のスライド: 2");
    expect(r.target).toBe(2);
    expect(r.sequence).toHaveLength(4);
    expect((r.sequence![2] as { spec: { meta: { title: string } } }).spec.meta.title).toBe("二の後半");
  });

  it("edits が空でも sequence だけ（入れ替え）を返せる。旧 remove は sequence に変換され remove は残らない", async () => {
    const deck = { current: 1, total: 3, slides: [{ number: 2, title: "二", spec: spec("二") }, { number: 3, title: "三", spec: spec("三") }] };
    ai.ask.mockResolvedValue(JSON.stringify({ reply: "入れ替えた", edits: [], sequence: [3, 2, 1] }));
    expect(await editPoster({ spec: current, instruction: "1と3を入れ替えて", deck })).toEqual({ reply: "入れ替えた", sequence: [3, 2, 1] });
    ai.ask.mockResolvedValue(JSON.stringify({ reply: "まとめた", edits: [{ target: 2, spec: spec("統合") }], remove: [3] }));
    const r = await editPoster({ spec: current, instruction: "2と3を1枚に", deck });
    expect(r.sequence).toEqual([1, 2]);
    expect(r).not.toHaveProperty("remove");
  });

  it("参考スライドを落とした sequence はエラー（AI にやり直させる）", async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ reply: "消した", edits: [], sequence: [1] }));
    await expect(editPoster({
      spec: current, instruction: "2枚目を消して",
      deck: { current: 1, total: 2, slides: [{ number: 2, title: "二", texts: ["本文"] }] },
    })).rejects.toThrow("参考スライド 2");
  });
});
