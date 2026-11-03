/**
 * 要望・不具合をアプリから直接起票するための、アプリ ⇄ 中継（Cloudflare Worker, relay/）の約束（Issue #77）。
 * 画面（src/editor）・アプリのサーバー（server/routes/feedback.ts）・中継（relay/src）が同じ定数と型を使う。
 * 利用者は GitHub のアカウントが無くても送れる。中継が Bot のトークンで GitHub の Issue を作る
 */

export type FeedbackKind = "request" | "bug" | "question";
export const FEEDBACK_KINDS: readonly FeedbackKind[] = ["request", "bug", "question"];
export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = { request: "要望", bug: "不具合", question: "質問" };

/** 件名・本文の上限（文字数）。中継でも同じ値で検証する */
export const FEEDBACK_MAX_TITLE = 200;
export const FEEDBACK_MAX_BODY = 6000;
/** 環境の各項目（版・OS）の上限（文字数） */
export const FEEDBACK_MAX_ENV_FIELD = 64;

export type FeedbackEnv = {
  /** アプリの版（取れなければ ""） */
  appVersion: string;
  /** 製品版（Electron）か開発版（ブラウザ）か */
  desktop: boolean;
  os: string;
};

/** アプリ → 中継の本文（JSON）。title は種類の接頭辞（[要望] など）を付けない利用者の入力そのもの */
export type FeedbackRequest = { kind: FeedbackKind; title: string; body: string; env?: FeedbackEnv };

/** 中継 → アプリの成功応答（201） */
export type FeedbackResponse = { number: number; url: string };

/** 中継の失敗応答（4xx / 5xx）。message は利用者に見せてよい日本語。GitHub のエラー本文は入れない */
export type FeedbackErrorResponse = { error: "invalid" | "rate_limited" | "unavailable"; message: string };

/** 中継の送り先。製品版の外部通信の許可表（server/egress.ts）はこの host・path だけを通す */
export const FEEDBACK_RELAY_HOST = "dc-designer-feedback.1kki-mrkm22.workers.dev";
export const FEEDBACK_RELAY_PATH = "/v1/issues";
export const FEEDBACK_RELAY_URL = `https://${FEEDBACK_RELAY_HOST}${FEEDBACK_RELAY_PATH}`;

/** 起票先のリポジトリと、アプリから来た Issue に付けるラベル */
export const FEEDBACK_REPO = "itiwoja/DC-Designer";
export const FEEDBACK_LABEL = "from-app";
export const FEEDBACK_KIND_GITHUB_LABEL: Record<FeedbackKind, string> = { request: "enhancement", bug: "bug", question: "question" };

/** 制御文字（改行・タブ以外）を除く */
const stripControls = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

/**
 * 受け取った JSON を検証して FeedbackRequest にする。合わなければ null。
 * 件名は前後の空白を除いて 1〜FEEDBACK_MAX_TITLE 文字、本文は FEEDBACK_MAX_BODY 文字まで（超えたら null。切り詰めは送る側の仕事）。
 * 知らないキーは捨てる。アプリのサーバーと中継の両方がこれで検証する
 */
export function parseFeedbackRequest(v: unknown): FeedbackRequest | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== "string" || !(FEEDBACK_KINDS as readonly string[]).includes(o.kind)) return null;
  if (typeof o.title !== "string" || typeof o.body !== "string") return null;
  const title = stripControls(o.title).trim();
  const body = stripControls(o.body).trim();
  if (!title || title.length > FEEDBACK_MAX_TITLE || body.length > FEEDBACK_MAX_BODY) return null;
  const out: FeedbackRequest = { kind: o.kind as FeedbackKind, title, body };
  if (o.env !== undefined) {
    const e = o.env as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || typeof e.appVersion !== "string" || typeof e.os !== "string" || typeof e.desktop !== "boolean") return null;
    const field = (s: string) => stripControls(s).trim().slice(0, FEEDBACK_MAX_ENV_FIELD);
    out.env = { appVersion: field(e.appVersion), desktop: e.desktop, os: field(e.os) };
  }
  return out;
}
