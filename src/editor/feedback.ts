/** 要望・不具合の送信まわり。通常はアプリ内で送る（api.sendFeedback）。予備として GitHub の新規 Issue 画面を開く URL も作れる */

import type { FeedbackEnv, FeedbackKind } from "../../desktop/feedbackRelay";
import { FEEDBACK_KIND_LABELS, FEEDBACK_MAX_BODY, FEEDBACK_MAX_TITLE } from "../../desktop/feedbackRelay";
export type { FeedbackEnv, FeedbackKind, FeedbackRequest, FeedbackResponse } from "../../desktop/feedbackRelay";
export { FEEDBACK_KIND_LABELS, FEEDBACK_MAX_BODY, FEEDBACK_MAX_ENV_FIELD, FEEDBACK_MAX_TITLE, FEEDBACK_SELECTABLE_KINDS } from "../../desktop/feedbackRelay";

/** 不具合のときにフォームへ最初から入れておく本文 */
export const BUG_TEMPLATE = "## 起きたこと\n\n\n## 再現手順\n1. \n\n## 期待した動き\n";

export const FEEDBACK_ISSUE_URL = "https://github.com/itiwoja/DC-Designer/issues/new";
const TRUNCATED_NOTE = "\n（長いため途中で切りました）";

/** 画面を開いている OS の名前（取れなければ "不明"） */
export function detectOs(): string {
  if (typeof navigator === "undefined") return "不明";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || nav.platform || "不明";
}

function envSection(env: FeedbackEnv): string {
  return [
    "---",
    "環境",
    `- アプリの版: ${env.appVersion || "不明"}`,
    `- 種類: ${env.desktop ? "製品版" : "開発版"}`,
    `- OS: ${env.os || "不明"}`,
  ].join("\n");
}

/** 件名が空なら Error（呼び出し側でボタンを無効にしておく） */
export function buildFeedbackUrl({ kind, title, body, env }: { kind: FeedbackKind; title: string; body: string; env?: FeedbackEnv }): string {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("件名が空です");
  const fullTitle = `[${FEEDBACK_KIND_LABELS[kind]}] ${trimmed}`.slice(0, FEEDBACK_MAX_TITLE);
  const tail = env ? `\n\n${envSection(env)}` : "";
  let text = body.trim();
  // 環境節は残し、利用者の内容のほうを切る
  if (text.length + tail.length > FEEDBACK_MAX_BODY) {
    text = text.slice(0, Math.max(0, FEEDBACK_MAX_BODY - tail.length - TRUNCATED_NOTE.length)) + TRUNCATED_NOTE;
  }
  const url = new URL(FEEDBACK_ISSUE_URL);
  url.searchParams.set("title", fullTitle);
  url.searchParams.set("body", text + tail);
  return url.toString();
}

/** 本文の残り文字数を出し始める境目 */
export const FEEDBACK_REMAINING_SHOW = 500;

/** 本文の残り文字数の表示。まだ余裕があるときは null */
export function remainingLabel(bodyLength: number): string | null {
  const left = Math.max(0, FEEDBACK_MAX_BODY - bodyLength);
  return left < FEEDBACK_REMAINING_SHOW ? `残り ${left.toLocaleString("en-US")} 文字` : null;
}

/** 送信に失敗したときの表示。code は server が付ける。通信の失敗（status なし）と中継の不調では、ブラウザで送る予備を出す */
export function feedbackErrorView(e: unknown): { message: string; canFallback: boolean } {
  const err = e as { message?: string; status?: number; code?: string } | null;
  const canFallback = err?.code === "feedback_unavailable" || err?.code === "feedback_rate_limited" || typeof err?.status !== "number";
  if (typeof err?.status !== "number") return { message: "通信に失敗しました。", canFallback };
  const message = err?.message || "送れませんでした。しばらくしてからもう一度お試しください。";
  return { message, canFallback };
}

/** 完了後に「GitHub で見る」を出してよい URL か */
export const isGithubUrl = (url: string) => url.startsWith("https://github.com/");
