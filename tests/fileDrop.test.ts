import { describe, expect, it, vi } from "vitest";
import { blockPageFileDrop, hasFiles, homeDropLabel, pickHomeDrop } from "../src/editor/fileDrop";

const pdf = new File(["%PDF"], "資料.pdf", { type: "application/pdf" });
const pptx = new File([""], "発表.PPTX", { type: "" });
const png = new File([""], "写真.png", { type: "image/png" });

describe("hasFiles", () => {
  it("ファイルのドラッグだけ true（文字・レイヤー ID のドラッグでは false）", () => {
    expect(hasFiles({ types: ["Files"] })).toBe(true);
    expect(hasFiles({ types: ["text/plain"] })).toBe(false);
    expect(hasFiles(null)).toBe(false);
  });
});

describe("pickHomeDrop", () => {
  it("PDF はモード選択・ポスター・スライドのどのホームでも開く（PDF を優先）", () => {
    for (const mode of [undefined, "poster", "slides"] as const) {
      expect(pickHomeDrop([png, pptx, pdf], mode)).toEqual({ kind: "pdf", file: pdf });
    }
  });
  it(".pptx はモード選択画面とスライドのホームで開き、ポスターのホームでは案内を出す", () => {
    expect(pickHomeDrop([pptx], undefined)).toEqual({ kind: "pptx", file: pptx });
    expect(pickHomeDrop([pptx], "slides")).toEqual({ kind: "pptx", file: pptx });
    expect(pickHomeDrop([pptx], "poster")).toMatchObject({ error: expect.stringContaining("スライド") });
  });
  it("開けないファイルは理由を返し、何もなければ null", () => {
    expect(pickHomeDrop([png], "slides")).toMatchObject({ error: expect.stringContaining("PDF か PowerPoint") });
    expect(pickHomeDrop([png], "poster")).toMatchObject({ error: expect.stringContaining("PDF") });
    expect(pickHomeDrop([], "slides")).toBeNull();
  });
  it("Instagram のホームでは何もしない", () => {
    expect(pickHomeDrop([pdf], "instagram")).toBeNull();
    expect(homeDropLabel("instagram")).toBeNull();
    expect(homeDropLabel("poster")).toBe("PDF をドロップして開く");
    expect(homeDropLabel(undefined)).toContain("PowerPoint");
  });
});

describe("blockPageFileDrop", () => {
  it("ファイルの dragover / drop だけ既定の動作（ファイルを開く）を止め、解除で外れる", () => {
    const handlers = new Map<string, (e: DragEvent) => void>();
    const target = {
      addEventListener: vi.fn((type: string, fn: (e: DragEvent) => void) => handlers.set(type, fn)),
      removeEventListener: vi.fn((type: string) => handlers.delete(type)),
    };
    const off = blockPageFileDrop(target as unknown as Window);
    expect([...handlers.keys()].sort()).toEqual(["dragover", "drop"]);
    const fileEvent = { dataTransfer: { types: ["Files"] }, preventDefault: vi.fn() } as unknown as DragEvent;
    const textEvent = { dataTransfer: { types: ["text/plain"] }, preventDefault: vi.fn() } as unknown as DragEvent;
    handlers.get("drop")!(fileEvent);
    handlers.get("drop")!(textEvent);
    expect(fileEvent.preventDefault).toHaveBeenCalledOnce();
    expect(textEvent.preventDefault).not.toHaveBeenCalled();
    off();
    expect(handlers.size).toBe(0);
  });
});
