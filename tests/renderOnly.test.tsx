// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopBridge, RuntimeSnapshot } from "../desktop/bridge";
import { Application } from "../src/Application";
import { RenderOnly } from "../src/render/RenderOnly";
import { BLANK_SPEC } from "../src/editor/nav";

const { poster } = vi.hoisted(() => ({ poster: vi.fn() }));
vi.mock("../src/editor/api", () => ({ api: { poster } }));
vi.mock("../src/editor/Home", () => ({ Home: () => <div>ホーム画面</div> }));
vi.mock("../src/editor/Library", () => ({ Library: () => <div>成果物画面</div> }));
vi.mock("../src/editor/App", () => ({ App: () => <div>エディタ画面</div> }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  poster.mockReset();
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("exe の描画専用画面も ready まで API を呼ばず、更新ポップアップを表示しない", async () => {
  let notify!: (state: RuntimeSnapshot) => void;
  const updateState = vi.fn();
  vi.stubGlobal("dcDesktop", {
    runtime: {
      getState: async () => ({ state: "starting", appVersion: "1.0.0" }),
      onStateChanged: (fn: typeof notify) => { notify = fn; return () => {}; },
    },
    close: { onPrepare: () => () => {} },
    window: { setTheme: () => {} },
    update: { getState: updateState, onStateChanged: () => () => {} },
  } as unknown as DesktopBridge);
  poster.mockResolvedValue({ spec: BLANK_SPEC });
  await act(async () => root.render(<Application params={new URLSearchParams("view=render&poster=test")} />));
  expect(poster).not.toHaveBeenCalled();
  await act(async () => notify({ state: "ready", appVersion: "1.0.0" }));
  expect(poster).toHaveBeenCalledExactlyOnceWith("test");
  expect(container.querySelector("svg")).not.toBeNull();
  expect(updateState).not.toHaveBeenCalled();
});

it.each([
  ["chatgpt=ok", "エディタ画面"], ["chatgpt_error=denied", "エディタ画面"],
  ["view=editor", "エディタ画面"], ["view=library", "成果物画面"], ["view=unknown", "ホーム画面"],
])("画面の遅延読み込みでも URL の振り分けを維持する: %s", async (query, text) => {
  await act(async () => root.render(<Application params={new URLSearchParams(query)} />));
  expect(container.textContent).toContain(text);
});

it("空の poster パラメーターでも白紙を描画する", async () => {
  await act(async () => root.render(<RenderOnly posterId="" theme="night" />));
  expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 1000 1414");
  expect(poster).not.toHaveBeenCalled();
});

it("取得失敗を表示し、別のポスターへ切り替えた後に古い結果で上書きしない", async () => {
  let previous!: (value: unknown) => void;
  poster.mockReturnValueOnce(new Promise((resolve) => { previous = resolve; }));
  await act(async () => root.render(<RenderOnly posterId="old" theme={null} />));
  poster.mockRejectedValueOnce(new Error("404"));
  await act(async () => root.render(<RenderOnly posterId="new" theme={null} />));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("ポスターを読み込めませんでした。");
  await act(async () => previous({ spec: BLANK_SPEC }));
  expect(container.querySelector("svg")).toBeNull();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
