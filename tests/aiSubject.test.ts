import { describe, expect, it } from "vitest";
import { deckSubject, posterSubject, watchWork, withSubject, workSubject } from "../src/editor/aiSubject";

describe("AI 依頼の subject", () => {
  it("保存済みポスターは poster、デッキは deck で、題名は 200 文字までにする", () => {
    expect(posterSubject("abcdef123456", "春祭り")).toEqual({ kind: "poster", id: "abcdef123456", title: "春祭り" });
    expect(deckSubject({ id: "abcdef123456", name: "あ".repeat(300) })?.title).toHaveLength(200);
    expect(posterSubject("abcdef123456", "  ")?.title).toBe("無題");
  });
  it("id が無い・形が違う（保存前）なら付けない", () => {
    expect(posterSubject(null, "x")).toBeUndefined();
    expect(posterSubject("ABC", "x")).toBeUndefined();
    expect(deckSubject(null)).toBeUndefined();
  });
  it("デッキを開いていればデッキを優先する", () => {
    const deck = { id: "deckdeck1234", name: "授業" };
    expect(workSubject(deck, "abcdef123456", "1枚目")).toEqual({ kind: "deck", id: "deckdeck1234", title: "授業" });
    expect(workSubject(null, "abcdef123456", "ポスター")?.kind).toBe("poster");
  });
  it("withSubject は subject が無ければ本文を変えない", () => {
    const body = { a: 1 };
    expect(withSubject(body, undefined)).toBe(body);
    expect(withSubject(body, posterSubject("abcdef123456", "t"))).toEqual({ a: 1, subject: { kind: "poster", id: "abcdef123456", title: "t" } });
  });
});

describe("watchWork（製品版で結果を当てはめてよいか）", () => {
  it("参照が変わらなければ変更なし、spec が置き換わったら変更あり", () => {
    const a = {}, b = {};
    let state: unknown[] = ["id", a];
    const changed = watchWork(true, () => state);
    expect(changed()).toBe(false);
    state = ["id", b];
    expect(changed()).toBe(true);
  });
  it("作品の切り替え・スライド数の変化も変更とみなす", () => {
    const a = {};
    let state: unknown[] = ["id1", a];
    const changed = watchWork(true, () => state);
    state = ["id2", a];
    expect(changed()).toBe(true);
    const c2 = watchWork(true, () => state);
    state = ["id2", a, {}];
    expect(c2()).toBe(true);
  });
  it("開発版（enabled が偽）は何をしても変更なし", () => {
    let state: unknown[] = [{}];
    const changed = watchWork(false, () => state);
    state = [{}];
    expect(changed()).toBe(false);
  });
});
