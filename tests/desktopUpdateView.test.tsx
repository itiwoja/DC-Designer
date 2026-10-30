// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopBridge, UpdateSnapshot } from "../desktop/bridge";
import { DesktopUpdate } from "../src/editor/DesktopUpdate";

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
});

function setup(initial: UpdateSnapshot) {
  let notify: (s: UpdateSnapshot) => void = () => {};
  const update = {
    getState: vi.fn(async () => initial),
    onStateChanged: (cb: typeof notify) => { notify = cb; return () => {}; },
    respond: vi.fn(async (): Promise<UpdateSnapshot> => ({ ...initial, prompt: undefined })),
    download: vi.fn(async (): Promise<UpdateSnapshot> => ({ ...initial, state: "downloading", prompt: { id: "p2", kind: "progress" } })),
    install: vi.fn(async (): Promise<UpdateSnapshot> => initial),
    check: vi.fn(),
  };
  vi.stubGlobal("dcDesktop", { update } as unknown as DesktopBridge);
  return { update, notify: (s: UpdateSnapshot) => notify(s) };
}

const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;

it("新版の案内：右下のトーストで出し、フォーカスは奪わない。更新内容はテキストのまま出し、「更新する」で案内した版を取得する", async () => {
  const { update } = setup({
    state: "available", currentVersion: "1.0.2", latestVersion: "1.0.3",
    releaseNotes: "<img src=x onerror=alert(1)>修正", prompt: { id: "p1", kind: "available" },
  });
  await act(async () => root.render(<DesktopUpdate />));
  expect(container.querySelector(".desktop-update")?.textContent).toContain("1.0.2 → 最新 1.0.3");
  expect(container.querySelector("img")).toBeNull();
  expect(document.activeElement).toBe(document.body);
  await act(async () => button("更新する").click());
  expect(update.download).toHaveBeenCalledWith("1.0.3");
  expect(container.textContent).toContain("更新をダウンロードしています");
});

it("Esc はトースト内に焦点があるときだけ保留として答え、案内を閉じる", async () => {
  const { update } = setup({ state: "available", currentVersion: "1.0.2", latestVersion: "1.0.3", prompt: { id: "p1", kind: "available" } });
  await act(async () => root.render(<DesktopUpdate />));
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(update.respond).not.toHaveBeenCalled();
  button("あとで").focus();
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(update.respond).toHaveBeenCalledWith("p1", "later");
  expect(container.querySelector(".desktop-update")).toBeNull();
});

it("取得済みなら「保存して再起動」で適用を頼む。案内が無ければ何も出さない", async () => {
  const { update, notify } = setup({ state: "downloaded", currentVersion: "1.0.2", latestVersion: "1.0.3", prompt: { id: "p3", kind: "downloaded" } });
  await act(async () => root.render(<DesktopUpdate />));
  await act(async () => button("保存して再起動").click());
  expect(update.install).toHaveBeenCalledWith("1.0.3");
  await act(async () => notify({ state: "downloaded", currentVersion: "1.0.2", latestVersion: "1.0.3" }));
  expect(container.querySelector(".desktop-update")).toBeNull();
});
