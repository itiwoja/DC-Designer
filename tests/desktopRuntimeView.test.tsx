// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopBridge, RuntimeSnapshot } from "../desktop/bridge";
import { DesktopRuntime } from "../src/editor/DesktopRuntime";
import { handlePrepareClose, registerCloseSave } from "../src/editor/desktop";

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

it("複数の子の編集状態を終了・失敗・再起動で維持し、終了前に未保存の内容を保存する", async () => {
  let notify: (s: RuntimeSnapshot) => void = () => {};
  const offState = vi.fn();
  const offClose = vi.fn();
  const complete = vi.fn();
  const bridge = {
    runtime: {
      getState: async () => ({ state: "starting", appVersion: "1.0.0" }),
      onStateChanged: (cb: typeof notify) => { notify = cb; return offState; },
    },
    close: { onPrepare: () => offClose, complete },
  } as unknown as DesktopBridge;
  vi.stubGlobal("dcDesktop", bridge);
  let mounts = 0;
  const save = vi.fn();
  function Editor() {
    const [draft, setDraft] = useState("initial");
    useEffect(() => { mounts++; }, []);
    useEffect(() => registerCloseSave(async () => { save(draft); return true; }), [draft]);
    return <><button onClick={() => setDraft("unsaved user edit")}>編集</button><textarea readOnly value={draft} /></>;
  }
  // main.tsx と同じ複数の子。子が1つだけでは再マウントの回帰を検出できない
  await act(async () => root.render(<DesktopRuntime><Editor /><div>通知欄</div></DesktopRuntime>));
  expect(mounts).toBe(0);
  const state = async (state: RuntimeSnapshot["state"]) => {
    await act(async () => notify({ state, appVersion: "1.0.0", ...(state === "failed" ? { error: "WORKER_LOST" as const } : {}) }));
  };
  await state("ready");
  await act(async () => container.querySelector("button")!.click());
  const input = container.querySelector("textarea")!;
  expect(input.value).toBe("unsaved user edit");
  await state("closing");
  expect(container.querySelector("textarea")).toBe(input);
  expect(input.value).toBe("unsaved user edit");
  await act(async () => handlePrepareClose(bridge, { requestId: "close-1" }));
  expect(save).toHaveBeenCalledExactlyOnceWith("unsaved user edit");
  expect(complete).toHaveBeenCalledWith({ requestId: "close-1", allSaved: true, busy: false });
  for (const next of ["ready", "failed", "starting", "ready"] as const) {
    await state(next);
    expect(container.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("unsaved user edit");
  }
  expect(mounts).toBe(1);
  await act(async () => root.unmount());
  expect(offState).toHaveBeenCalledTimes(1);
  expect(offClose).toHaveBeenCalledTimes(1);
});
