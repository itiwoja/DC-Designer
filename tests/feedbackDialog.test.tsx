// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/editor/api";
import { FeedbackDialog } from "../src/editor/FeedbackDialog";
import { feedbackErrorView, remainingLabel } from "../src/editor/feedback";

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

const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label);
async function fillTitle(text: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const err = (message: string, extra: object) => Object.assign(new Error(message), extra);

it("種類の選択肢は「要望」「不具合」だけ（質問は出さない）", async () => {
  await act(async () => root.render(<FeedbackDialog onClose={() => {}} />));
  const radios = [...container.querySelectorAll<HTMLInputElement>('input[name="feedback-kind"]')];
  expect(radios.map((r) => r.parentElement!.textContent?.trim())).toEqual(["要望", "不具合"]);
  expect(container.textContent).not.toContain("質問");
});

it("成功：番号を表示し、https://github.com/ の URL だけ「GitHub で見る」を出す", async () => {
  vi.spyOn(api, "sendFeedback").mockResolvedValue({ number: 123, url: "https://github.com/itiwoja/DC-Designer/issues/123" });
  const open = vi.fn();
  vi.stubGlobal("open", open);
  await act(async () => root.render(<FeedbackDialog onClose={() => {}} />));
  await fillTitle("色");
  await act(async () => button("送る")!.click());
  expect(container.textContent).toContain("#123 として送りました。ありがとうございます。");
  await act(async () => button("GitHub で見る")!.click());
  expect(open).toHaveBeenCalledWith("https://github.com/itiwoja/DC-Designer/issues/123", "_blank", "noopener,noreferrer");
});

it("成功でも URL が GitHub 以外なら「GitHub で見る」は出さない", async () => {
  vi.spyOn(api, "sendFeedback").mockResolvedValue({ number: 5, url: "https://example.com/x" });
  await act(async () => root.render(<FeedbackDialog onClose={() => {}} />));
  await fillTitle("色");
  await act(async () => button("送る")!.click());
  expect(button("GitHub で見る")).toBeUndefined();
  expect(button("閉じる")).toBeDefined();
});

it("失敗（feedback_unavailable）：入力を残し、alert と予備ボタンを出す。予備はブラウザで GitHub を開く", async () => {
  vi.spyOn(api, "sendFeedback").mockRejectedValue(err("今は送れません", { status: 503, code: "feedback_unavailable" }));
  const open = vi.fn();
  vi.stubGlobal("open", open);
  await act(async () => root.render(<FeedbackDialog onClose={() => {}} />));
  await fillTitle("色");
  await act(async () => button("送る")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("今は送れません");
  expect(container.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("色");
  expect(button("送る")!.disabled).toBe(false);
  await act(async () => button("ブラウザの GitHub で送る")!.click());
  expect(String(open.mock.calls[0][0])).toContain("https://github.com/itiwoja/DC-Designer/issues/new");
});

it("失敗（400 の入力の誤り）：予備ボタンは出さない", async () => {
  vi.spyOn(api, "sendFeedback").mockRejectedValue(err("件名が長すぎます", { status: 400, code: "invalid" }));
  await act(async () => root.render(<FeedbackDialog onClose={() => {}} />));
  await fillTitle("色");
  await act(async () => button("送る")!.click());
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(button("ブラウザの GitHub で送る")).toBeUndefined();
});

it("送信中：ボタンは「送っています…」で無効、二重に送らない。中断すると閉じて、後から返っても何も起きない", async () => {
  let signal: AbortSignal | undefined;
  let resolve: (v: { number: number; url: string }) => void = () => {};
  const spy = vi.spyOn(api, "sendFeedback").mockImplementation((_r, s) => { signal = s; return new Promise((r) => { resolve = r; }); });
  const onClose = vi.fn();
  await act(async () => root.render(<FeedbackDialog onClose={onClose} />));
  await fillTitle("色");
  await act(async () => button("送る")!.click());
  const busy = button("送っています…")!;
  expect(busy.disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>('input[type="text"]')!.disabled).toBe(true);
  await act(async () => busy.click());
  expect(spy).toHaveBeenCalledTimes(1);
  await act(async () => button("キャンセル")!.click());
  expect(signal?.aborted).toBe(true);
  expect(onClose).toHaveBeenCalled();
  await act(async () => { resolve({ number: 1, url: "https://github.com/x" }); });
  expect(container.textContent).not.toContain("として送りました");
});

it("Esc でも中断して閉じる", async () => {
  let signal: AbortSignal | undefined;
  vi.spyOn(api, "sendFeedback").mockImplementation((_r, s) => { signal = s; return new Promise(() => {}); });
  const onClose = vi.fn();
  await act(async () => root.render(<FeedbackDialog onClose={onClose} />));
  await fillTitle("色");
  await act(async () => button("送る")!.click());
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(signal?.aborted).toBe(true);
  expect(onClose).toHaveBeenCalled();
});

it("残り文字数は 500 文字を切ってから出す", () => {
  expect(remainingLabel(5000)).toBeNull();
  expect(remainingLabel(5500)).toBeNull();
  expect(remainingLabel(5501)).toBe("残り 499 文字");
  expect(remainingLabel(6000)).toBe("残り 0 文字");
});

it("通信の失敗（status なし）は予備を出す", () => {
  expect(feedbackErrorView(new TypeError("Failed to fetch")).canFallback).toBe(true);
  expect(feedbackErrorView(err("x", { status: 429, code: "feedback_rate_limited" })).canFallback).toBe(true);
  expect(feedbackErrorView(err("x", { status: 400 })).canFallback).toBe(false);
});
