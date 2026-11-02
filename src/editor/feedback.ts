/** 要望・不具合を GitHub の新規 Issue 画面で開くための URL を作る（アプリは直接送らず、利用者が自分のアカウントで送る） */

export type FeedbackKind = "request" | "bug" | "question";

export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = { request: "要望", bug: "不具合", question: "質問" };

/** 不具合のときにフォームへ最初から入れておく本文 */
export const BUG_TEMPLATE = "## 起きたこと\n\n\n## 再現手順\n1. \n\n## 期待した動き\n";

export const FEEDBACK_ISSUE_URL = "https://github.com/itiwoja/DC-Designer/issues/new";
/** URL が長すぎると GitHub が受け付けないので本文・件名を切る */
export const FEEDBACK_MAX_BODY = 6000;
export const FEEDBACK_MAX_TITLE = 200;
const TRUNCATED_NOTE = "\n（長いため途中で切りました）";

export type FeedbackEnv = {
  /** アプリの版（取れなければ ""） */
  appVersion: string;
  /** 製品版（Electron）か開発版（ブラウザ）か */
  desktop: boolean;
  os: string;
};

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
