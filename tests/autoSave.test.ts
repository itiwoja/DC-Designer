// 保存状態の回帰テスト（.output/bug-investigation.md の BUG-01〜03）。
// SSR でフックを初期化し、描画時の ref 更新を手で再現する（effect・実ブラウザのタブ操作は検証しない）
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PosterSpecSchema } from "../src/schema";
import { resolveTheme } from "../src/themes";
import { api } from "../src/editor/api";
import { CURRENT_ID_KEY, STORAGE_KEY, SYNCED_KEY } from "../src/editor/storage";
import { SAVE_FAILED, useAutoSave } from "../src/editor/useAutoSave";
import { useDeck } from "../src/editor/useDeck";

const spec = (title: string) => PosterSpecSchema.parse({ meta: { title, width: 1000, height: 1414 }, theme: "ocean", layers: [] });
const saved = (id: string, s: ReturnType<typeof spec>) => ({ id, spec: s, createdAt: "", updatedAt: "" });
const A = "aaaaaaaaaaaa", B = "bbbbbbbbbbbb", N = "nnnnnnnnnnnn";
let values: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers();
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  });
  vi.stubGlobal("navigator", { locks: { request: async (_: string, cb: () => unknown) => cb() } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function harness(initial: ReturnType<typeof spec>) {
  let save!: ReturnType<typeof useAutoSave>;
  let deck!: ReturnType<typeof useDeck>;
  const resetSpec = vi.fn((next) => { save.specRef.current = next; });
  const stashHistory = vi.fn(() => ({ past: [], future: [] }));
  function Probe() {
    save = useAutoSave(initial, vi.fn(), true);
    deck = useDeck({ spec: initial, theme: resolveTheme(initial.theme), save, apiUp: true,
      busy: null, run: vi.fn(), notify: vi.fn(), exported: vi.fn(), setBusyProgress: vi.fn(),
      setSpec: vi.fn(), resetSpec, stashHistory, setSelected: vi.fn(), fitView: vi.fn() });
    return null;
  }
  renderToString(createElement(Probe));
  return { save, deck, resetSpec };
}

it("保存済みと確かめられないブラウザ控えは、読み込み直した後の保存ボタンでサーバーへ送る", async () => {
  const unsaved = spec("サーバーに未反映の編集");
  values.set(CURRENT_ID_KEY, A);
  values.set(STORAGE_KEY, JSON.stringify(unsaved));
  const put = vi.spyOn(api, "savePoster").mockResolvedValue(saved(A, unsaved));
  const { save } = harness(unsaved);
  expect(await save.saveNow()).toBe(true);
  expect(put).toHaveBeenCalledWith(A, unsaved);
  expect(values.get(SYNCED_KEY)).toBe("1");
});

it("保存済みの控えなら、読み込み直しても送り直さない", async () => {
  const s = spec("保存済み");
  values.set(CURRENT_ID_KEY, A);
  values.set(STORAGE_KEY, JSON.stringify(s));
  values.set(SYNCED_KEY, "1");
  const put = vi.spyOn(api, "savePoster");
  const { save } = harness(s);
  expect(await save.saveNow()).toBe(true);
  expect(put).not.toHaveBeenCalled();
});

it("保存に失敗したら saveNow は false を返す", async () => {
  values.set(CURRENT_ID_KEY, A);
  vi.spyOn(api, "savePoster").mockRejectedValue(new Error("HTTP 500"));
  const { save } = harness(spec("A"));
  save.specRef.current = spec("A 編集");
  expect(await save.saveNow()).toBe(false);
});

it("スライドの切り替えはサーバーを待たず、元のスライドの編集は裏で保存して失敗したら送り直す", async () => {
  const old = spec("A 保存済み"), edited = spec("A 未保存"), next = spec("B 保存済み");
  values.set(CURRENT_ID_KEY, A);
  values.set(SYNCED_KEY, "1");
  const put = vi.spyOn(api, "savePoster").mockRejectedValueOnce(new Error("HTTP 500")).mockResolvedValue(saved(A, edited));
  const { save } = harness(old);
  save.markSaved(B, next);
  save.specRef.current = edited;
  save.switchTo(B, next);
  // 切り替えはその場で済む（ID と内容が同時に B になる）
  expect(save.posterIdRef.current).toBe(B);
  expect(save.specRef.current).toBe(next);
  // B は保存済みなので送らず、A の編集だけを裏で送る。1 回目は失敗し、5 秒後に送り直す
  expect(await save.flushSave()).toBe(true);
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenLastCalledWith(A, edited);
  expect(await save.flushAll()).toBe(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(put).toHaveBeenCalledTimes(2);
  expect(put).toHaveBeenLastCalledWith(A, edited);
  expect(await save.flushAll()).toBe(true);
});

it("切り替える前に始まった保存は、切り替え後のスライドの保存済みの基準を変えない", async () => {
  const a = spec("A 編集"), b = spec("B 保存済み");
  values.set(CURRENT_ID_KEY, A);
  let finish!: () => void;
  const put = vi.spyOn(api, "savePoster").mockImplementation((id) => new Promise((res) => { finish = () => res(saved(id, a)); }));
  const { save } = harness(spec("A"));
  save.specRef.current = a;
  const pending = save.flushSave();
  await Promise.resolve();
  save.markSaved(B, b);
  save.switchTo(B, b);
  finish();
  expect(await pending).toBe(true);
  expect(put).toHaveBeenCalledWith(A, a);
  // A は保存済みになり、B を A の内容で上書きしない
  expect(await save.flushAll()).toBe(true);
  expect(put).toHaveBeenCalledTimes(1);
});

it("新規作成の保存待ちに別タブが既存 B を開いても、B を上書きせず新しく作る", async () => {
  values.set(CURRENT_ID_KEY, A);
  values.set(SYNCED_KEY, "1");
  const fresh = spec("新規ポスター");
  const put = vi.spyOn(api, "savePoster");
  const create = vi.spyOn(api, "createPoster").mockResolvedValue(saved(N, fresh));
  const del = vi.spyOn(api, "deletePoster").mockResolvedValue(undefined as never);
  const { save } = harness(spec("既存A"));
  const restore = await save.startNewPoster();
  save.specRef.current = fresh;
  // 別タブの openInEditor(B) による共有キー更新を再現
  values.set(CURRENT_ID_KEY, B);
  expect(await save.flushSave()).toBe(true);
  expect(put).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledWith(fresh);
  expect(save.posterIdRef.current).toBe(N);
  // 元に戻すと、作った N だけを消して A に戻る
  restore(spec("既存A"));
  await save.flushSave();
  expect(del).toHaveBeenCalledTimes(1);
  expect(del).toHaveBeenCalledWith(N);
  expect(save.posterIdRef.current).toBe(A);
});

// ---------- localStorage に控えを入れられないとき（容量超過）の成果物の切り替え ----------
it("控えを入れられないまま B を開いても、A の内容を B へ保存せず、B を読み込んでから通常どおり保存する", async () => {
  const a = spec("A の内容"), b = spec("B の内容"), edited = spec("B を編集");
  const loc = { href: "", search: "", pathname: "/" };
  vi.stubGlobal("location", loc);
  // A の控えがあり、以後の setItem は容量超過で投げる
  values.set(STORAGE_KEY, JSON.stringify(a));
  values.set(CURRENT_ID_KEY, A);
  values.set(SYNCED_KEY, "1");
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => { if (k === STORAGE_KEY) throw new Error("QuotaExceededError"); values.set(k, v); },
    removeItem: (k: string) => values.delete(k),
  });
  const { openInEditor } = await import("../src/editor/nav");
  openInEditor(saved(B, b), "poster");
  expect(values.has(STORAGE_KEY)).toBe(false);
  expect(values.get(CURRENT_ID_KEY)).toBe(B);
  expect(values.has(SYNCED_KEY)).toBe(false);
  expect(loc.href).toBe(`?view=editor&mode=poster&open=${B}`);

  // エディタ側: URL の印で開く。古い A の内容がエディタに残っている
  loc.search = "?view=editor&open=" + B;
  vi.stubGlobal("history", { replaceState: vi.fn() });
  vi.stubGlobal("URL", URL);
  const put = vi.spyOn(api, "savePoster").mockResolvedValue(saved(B, a));
  let release!: () => void;
  const get = vi.spyOn(api, "poster").mockImplementation(() => new Promise((res) => { release = () => res(saved(B, b)); }));
  const resetSpec = vi.fn();
  let hook!: ReturnType<typeof useAutoSave>;
  renderToString(createElement(function Probe() { hook = useAutoSave(a, vi.fn(), true, resetSpec); return null; }));
  expect(hook.posterIdRef.current).toBe(B);
  hook.specRef.current = spec("A を編集");
  // 読み込み前は保存しない
  expect(await hook.flushSave(true)).toBe(false);
  expect(await hook.saveNow()).toBe(false);
  expect(put).not.toHaveBeenCalled();

  // 読み込めたら B の内容に差し替わり（履歴もリセット）、以後は B へ保存できる
  const loaded = hook.loadOpened();
  release();
  expect(await loaded).toBe(true);
  expect(get).toHaveBeenCalledWith(B);
  expect(resetSpec).toHaveBeenCalledWith(b);
  expect(hook.specRef.current).toBe(b);
  hook.specRef.current = edited;
  expect(await hook.flushSave()).toBe(true);
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith(B, edited);
});

it("B の読み込みに失敗している間は、保存を試みても何も送らない", async () => {
  vi.stubGlobal("location", { href: "", search: `?view=editor&open=${B}`, pathname: "/" });
  values.set(CURRENT_ID_KEY, B);
  const put = vi.spyOn(api, "savePoster");
  vi.spyOn(api, "poster").mockRejectedValue(new Error("HTTP 500"));
  let hook!: ReturnType<typeof useAutoSave>;
  renderToString(createElement(function Probe() { hook = useAutoSave(spec("A"), vi.fn(), true); return null; }));
  expect(await hook.loadOpened()).toBe(false);
  hook.specRef.current = spec("A 編集");
  expect(await hook.flushSave(true)).toBe(false);
  expect(put).not.toHaveBeenCalled();
});
