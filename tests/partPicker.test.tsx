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
