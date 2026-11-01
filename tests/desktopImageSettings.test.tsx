// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import { api, type Status } from "../src/editor/api";
import { describeCodex, DesktopImageSettings } from "../src/editor/DesktopAccount";

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

const SECRET = "AIza-secret-value";
const mkBridge = (configured: boolean) => {
  const secrets = {
    status: vi.fn(async () => ({ ok: true, data: configured ? [{ secretRef: "gemini/apiKey", state: "configured" }] : [] })),
    set: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => ({ ok: true })),
  };
  return { bridge: { secrets } as unknown as DesktopBridge, secrets };
};
const st = (extra: object = {}) => ({ imageProvider: "comfyui", imageProviders: ["comfyui", "placeholder"], chatgpt: {}, ...extra } as unknown as Status);
async function mount(bridge: DesktopBridge, status: Status, props: Partial<Parameters<typeof DesktopImageSettings>[0]> = {}) {
  await act(async () => root.render(<DesktopImageSettings bridge={bridge} status={status} imageChoices={["comfyui"]} imageProvider="comfyui" onImageProvider={() => {}} {...props} />));
}
const setValue = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
};
const btn = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;

it("選択肢を日本語の名前で出し、仮の画像だけのときは「仮の画像」", async () => {
  const { bridge } = mkBridge(false);
  await mount(bridge, st(), { imageChoices: ["gemini", "comfyui", "codex"] });
  const opts = [...container.querySelectorAll("select option")].map((o) => o.textContent);
  expect(opts).toEqual(["Gemini（API キー）", "ComfyUI（この PC）", "ChatGPT（Codex CLI）"]);
  expect(container.textContent).toContain("透過非対応（白背景で生成）");
  await mount(bridge, st(), { imageChoices: [], imageProvider: undefined });
  expect(container.querySelector("select option")!.textContent).toBe("仮の画像");
});

it("キー保存で secrets.set が呼ばれ、値は画面に出ない", async () => {
  const { bridge, secrets } = mkBridge(false);
  const changed = vi.fn();
  await mount(bridge, st(), { onStatusChanged: changed });
  expect(container.textContent).toContain("API キー未設定");
  await setValue(container.querySelector<HTMLInputElement>('input[type="password"]')!, SECRET);
  secrets.status.mockResolvedValue({ ok: true, data: [{ secretRef: "gemini/apiKey", state: "configured" }] });
  await act(async () => btn("キーを保存").click());
  expect(secrets.set).toHaveBeenCalledWith("gemini", "apiKey", SECRET);
  expect(changed).toHaveBeenCalled();
  expect(container.textContent).toContain("API キーを保存済み");
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  expect(container.innerHTML).not.toContain(SECRET);
});

it("保存済みなら「キーを消す」で remove が呼ばれる", async () => {
  const { bridge, secrets } = mkBridge(true);
  await mount(bridge, st());
  expect(container.textContent).toContain("API キーを保存済み");
  await act(async () => btn("キーを消す").click());
  expect(secrets.remove).toHaveBeenCalledWith("gemini/apiKey");
});

it("ComfyUI・Codex の設定を保存し、400 のエラー文はそのまま出す", async () => {
  const { bridge } = mkBridge(false);
  const spy = vi.spyOn(api, "setImageSettings").mockRejectedValueOnce(new Error("ComfyUI の URL は 127.0.0.1 / localhost だけ使えます")).mockResolvedValueOnce({ comfyuiUrl: "http://localhost:8188", codexPath: "" });
  const changed = vi.fn();
  await mount(bridge, st({ imageSettings: { comfyuiUrl: "", codexPath: "" } }), { onStatusChanged: changed });
  await setValue(container.querySelector<HTMLInputElement>('input[aria-label="ComfyUI の URL"]')!, "http://example.com");
  await act(async () => btn("ComfyUI・Codex の設定を保存").click());
  expect(container.textContent).toContain("ComfyUI の URL は 127.0.0.1 / localhost だけ使えます");
  expect(changed).not.toHaveBeenCalled();
  await setValue(container.querySelector<HTMLInputElement>('input[aria-label="ComfyUI の URL"]')!, "http://localhost:8188");
  await act(async () => btn("ComfyUI・Codex の設定を保存").click());
  expect(spy).toHaveBeenLastCalledWith({ comfyuiUrl: "http://localhost:8188", codexPath: "" });
  expect(changed).toHaveBeenCalled();
  expect(container.textContent).not.toContain("127.0.0.1 / localhost だけ");
});

it("Codex の状態の文言", async () => {
  expect(describeCodex({ state: "ready", path: "C:\\x\\codex.exe" })).toBe("使えます（C:\\x\\codex.exe）");
  expect(describeCodex({ state: "not_found" })).toContain("見つかりません");
  expect(describeCodex({ state: "signed_out" })).toContain("サインインしていません");
  const { bridge } = mkBridge(false);
  await mount(bridge, st({ codex: { state: "signed_out" } }));
  expect(container.textContent).toContain("`codex login`");
});
