// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import { api, type SetupProgress, type Status } from "../src/editor/api";
import { codexSetup } from "../src/editor/codexSetup";
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
  expect(describeCodex({ state: "ready", path: "C:\\x\\codex.exe", source: "app" })).toBe("使えます（このアプリで入れた版）");
  expect(describeCodex({ state: "ready", source: "codex-app" })).toBe("使えます（Codex アプリの CLI）");
  expect(describeCodex({ state: "not_found" })).toContain("見つかりません");
  expect(describeCodex({ state: "signed_out" })).toContain("サインインしていません");
});

describe("Codex CLI を入れる・サインイン", () => {
  beforeEach(() => codexSetup.reset());
  const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label);

  it("見つからず入れられるなら「Codex CLI を入れる」を出し、押すとダウンロードの進み具合を出す。入れ終えたら続けてサインインする", async () => {
    let progress: ((p: SetupProgress) => void) | undefined;
    let finishInstall: (v: { path: string; version: string; signedIn: boolean }) => void = () => {};
    let finishLogin: (v: { signedIn: true }) => void = () => {};
    vi.spyOn(api, "installCodex").mockImplementation((onProgress) => { progress = onProgress; return new Promise((r) => { finishInstall = r; }); });
    const login = vi.spyOn(api, "loginCodex").mockImplementation((onProgress) => { progress = onProgress; return new Promise((r) => { finishLogin = r; }); });
    const onStatusChanged = vi.fn();
    const { bridge } = mkBridge(false);
    await mount(bridge, st({ codex: { state: "not_found", canInstall: true, installVersion: "0.166.0" } }), { onStatusChanged });
    expect(container.textContent).toContain("Codex CLI 0.166.0（約 120MB）");
    await act(async () => button("Codex CLI を入れる")!.click());
    expect(container.textContent).toContain("ダウンロードの準備をしています");
    expect(button("Codex CLI を入れる")).toBeUndefined();
    await act(async () => progress!({ phase: "setup", step: "download", done: 31 * 1024 * 1024, total: 124 * 1024 * 1024 }));
    expect(container.textContent).toContain("ダウンロード中… 25%（31.0 / 124.0 MB）");
    const bar = container.querySelector("progress")!;
    expect(bar.getAttribute("value")).toBe(String(31 * 1024 * 1024));
    await act(async () => progress!({ phase: "setup", step: "verify" }));
    expect(container.textContent).toContain("公式のファイルと一致するか確かめています");
    await act(async () => finishInstall({ path: "C:\\codex.exe", version: "0.166.0", signedIn: false }));
    expect(login).toHaveBeenCalled();
    expect(onStatusChanged).toHaveBeenCalled();
    expect(container.textContent).toContain("ブラウザで ChatGPT にサインインしてください");
    await act(async () => progress!({ phase: "setup", step: "login", url: "https://auth.openai.com/oauth/authorize?x=1" }));
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://auth.openai.com/oauth/authorize?x=1");
    await act(async () => finishLogin({ signedIn: true }));
    expect(container.querySelector("[role=status]")).toBeNull();
  });

  it("サインインしていなければ「Codex にサインイン」、失敗したらサーバーの文言を出す", async () => {
    vi.spyOn(api, "loginCodex").mockRejectedValue(new Error("Codex にサインインできませんでした。もう一度試してください"));
    const { bridge } = mkBridge(false);
    await mount(bridge, st({ codex: { state: "signed_out", canInstall: true, installVersion: "0.166.0" } }));
    await act(async () => button("Codex にサインイン")!.click());
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Codex にサインインできませんでした。もう一度試してください");
  });

  it("中止すると取り消しを送り、エラーは出さない", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(api, "installCodex").mockImplementation((_p, s) => { signal = s; return new Promise((_, rej) => s!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))); });
    const { bridge } = mkBridge(false);
    await mount(bridge, st({ codex: { state: "not_found", canInstall: true, installVersion: "0.166.0" } }));
    await act(async () => button("Codex CLI を入れる")!.click());
    await act(async () => button("中止")!.click());
    expect(signal?.aborted).toBe(true);
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(button("Codex CLI を入れる")).toBeTruthy();
  });

  it("入れられない PC では場所の指定を案内する", async () => {
    const { bridge } = mkBridge(false);
    await mount(bridge, st({ codex: { state: "not_found", canInstall: false, installVersion: "0.166.0" } }));
    expect(button("Codex CLI を入れる")).toBeUndefined();
    expect(container.textContent).toContain("codex.exe を指定してください");
  });
});
