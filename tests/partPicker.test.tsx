// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CATALOG } from "../src/components/catalog";
import { PartPicker, thumbProps } from "../src/editor/PartPicker";
import type { PosterSpec } from "../src/schema";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom には getBBox が無い（縮小フィット用）
  (SVGElement.prototype as unknown as { getBBox: () => object }).getBBox = () => ({ x: 0, y: 0, width: 10, height: 10 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const spec = { theme: "pop", layers: [] } as unknown as PosterSpec;
const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-label="パーツを追加"]')!;

it("開くと全パーツがサムネイル付きで並び、選ぶと追加して閉じる", async () => {
  const onPick = vi.fn();
  await act(async () => root.render(<PartPicker spec={spec} onPick={onPick} />));
  expect(container.querySelector(".part-grid")).toBeNull();
  await act(async () => trigger().click());
  const cells = [...container.querySelectorAll<HTMLButtonElement>(".part-cell")];
  expect(cells).toHaveLength(CATALOG.length);
  expect(cells.every((b) => b.querySelector("svg")?.childElementCount)).toBe(true);
  expect(cells[1].title).toBe(CATALOG[1].description);
  await act(async () => cells[1].click());
  expect(onPick).toHaveBeenCalledWith(CATALOG[1].name);
  expect(container.querySelector(".part-grid")).toBeNull();
});

it("Esc で閉じる", async () => {
  await act(async () => root.render(<PartPicker spec={spec} onPick={() => {}} />));
  await act(async () => trigger().click());
  expect(container.querySelector(".part-grid")).not.toBeNull();
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(container.querySelector(".part-grid")).toBeNull();
});

it("見本用の props はカタログの defaults を書き換えない", () => {
  const polaroid = CATALOG.find((c) => c.name === "polaroid")!;
  expect(thumbProps(polaroid).src).toBeTruthy();
  expect(polaroid.defaults.src).toBeUndefined();
});

const key = (k: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });

it("開くと最初のマスへフォーカスが入り、矢印キーで動き、Esc で閉じてボタンへ戻る", async () => {
  // jsdom には配置が無いので、3 列の並びとして offsetTop を返す
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get() { const cs = [...document.querySelectorAll(".part-cell")]; return Math.floor(cs.indexOf(this) / 3) * 100; },
  });
  try {
    await act(async () => root.render(<PartPicker spec={spec} onPick={() => {}} />));
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    await act(async () => trigger().click());
    const cells = [...container.querySelectorAll<HTMLButtonElement>(".part-cell")];
    expect(document.activeElement).toBe(cells[0]);
    await key("ArrowRight"); expect(document.activeElement).toBe(cells[1]);
    await key("ArrowDown"); expect(document.activeElement).toBe(cells[4]);
    await key("ArrowLeft"); expect(document.activeElement).toBe(cells[3]);
    await key("ArrowUp"); expect(document.activeElement).toBe(cells[0]);
    await key("ArrowUp"); expect(document.activeElement).toBe(cells[0]);
    await key("End"); expect(document.activeElement).toBe(cells[cells.length - 1]);
    await key("Home"); expect(document.activeElement).toBe(cells[0]);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(container.querySelector(".part-grid")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  } finally {
    if (desc) Object.defineProperty(HTMLElement.prototype, "offsetTop", desc); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetTop;
  }
});

it("選ぶと追加して、ボタンへフォーカスが戻る", async () => {
  const onPick = vi.fn();
  await act(async () => root.render(<PartPicker spec={spec} onPick={onPick} />));
  await act(async () => trigger().click());
  await act(async () => container.querySelectorAll<HTMLButtonElement>(".part-cell")[2].click());
  expect(onPick).toHaveBeenCalledWith(CATALOG[2].name);
  expect(document.activeElement).toBe(trigger());
});

it("親が描き直されても、開いている一覧は描き直さない", async () => {
  await act(async () => root.render(<PartPicker spec={spec} onPick={() => {}} />));
  await act(async () => trigger().click());
  const svg = container.querySelector(".part-cell svg")!;
  await act(async () => root.render(<PartPicker spec={spec} onPick={() => {}} />));
  expect(container.querySelector(".part-cell svg")).toBe(svg);
});
