// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LayersPanel } from "../src/editor/LayersPanel";
import { PosterSpecSchema } from "../src/schema";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const spec = PosterSpecSchema.parse({
  meta: { title: "t", width: 1000, height: 1414 },
  layers: [{ id: "a", type: "shape", shape: "rect", x: 0, y: 0, w: 100, h: 100 }],
});
const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
const render = (open: boolean, onToggle = vi.fn()) => act(async () => root.render(
  <LayersPanel
    spec={spec} selectedIds={[]} hovered={null} generatingIds={new Set()}
    onSelect={() => {}} onHover={() => {}} onUpdate={() => {}} onMoveTo={() => {}}
    onAddText={() => {}} onAddImage={() => {}} onAddComponent={() => {}}
    open={open} onToggle={onToggle}
  />,
));

it("開いているときは追加欄とレイヤー一覧を出し、aria-expanded は true", async () => {
  await render(true);
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(toggle().getAttribute("aria-label")).toBe("レイヤーを閉じる");
  expect(container.querySelector(".add-row")).not.toBeNull();
  expect(container.querySelector("ul.layers")).not.toBeNull();
});

it("閉じているときは見出しと追加欄だけで、レイヤー一覧を出さない", async () => {
  await render(false);
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(toggle().getAttribute("aria-label")).toBe("レイヤーを開く");
  expect(container.querySelector("h3")).not.toBeNull();
  // 文字・パーツを足せるのはこの欄だけなので、畳んでも残す
  expect(container.querySelector(".add-row")).not.toBeNull();
  expect(container.querySelector("ul.layers")).toBeNull();
});

it("見出しのボタンを押すと、今の状態の逆を onToggle に渡す", async () => {
  const onToggle = vi.fn();
  await render(true, onToggle);
  await act(async () => toggle().click());
  expect(onToggle).toHaveBeenLastCalledWith(false);

  await render(false, onToggle);
  await act(async () => toggle().click());
  expect(onToggle).toHaveBeenLastCalledWith(true);
});
