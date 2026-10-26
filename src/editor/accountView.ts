import type { DesktopResult } from "../../desktop/bridge";
import type { Status } from "./api";

/** 製品版の ChatGPT アカウント表示の状態 */
export type DesktopAccountView =
  | { kind: "loading" }
  | { kind: "signedOut"; previousEmail?: string }
  | { kind: "signedIn"; email?: string }
  | { kind: "noPlan"; email?: string }
  | { kind: "reauth"; email?: string };

/** secrets.status() の結果から、ChatGPT の資格情報が再認証待ちか調べる（読めない形なら false） */
export function isChatGPTReauthRequired(res: DesktopResult | undefined): boolean {
  if (!res || !res.ok || !Array.isArray(res.data)) return false;
  return res.data.some((e) => !!e && typeof e === "object" && (e as { secretRef?: unknown }).secretRef === "chatgpt/oauth" && (e as { state?: unknown }).state === "reauthRequired");
}

export function deriveDesktopAccountView(status: Status | null, reauthRequired: boolean): DesktopAccountView {
  if (!status) return { kind: "loading" };
  const gpt = status.chatgpt;
  // 資格情報が復号できないあいだは、状態の表示より再認証を優先する
  if (reauthRequired) return { kind: "reauth", email: gpt.signedIn ? gpt.email : gpt.previousEmail };
  if (!gpt.signedIn) return { kind: "signedOut", ...(gpt.previousEmail ? { previousEmail: gpt.previousEmail } : {}) };
  return gpt.planEnabled ? { kind: "signedIn", email: gpt.email } : { kind: "noPlan", email: gpt.email };
}

export type SignInOutcome = { tone: "success" | "info" | "error"; text: string };

/** auth.signIn の結果を通知文にする。失敗や読めない結果を成功にしない */
export function signInOutcome(res: DesktopResult): SignInOutcome {
  if (!res.ok) return { tone: "error", text: `ChatGPT でサインインできませんでした: ${res.error}` };
  const result = (res.data as { result?: unknown } | null)?.result;
  if (result === "signed-in") return { tone: "success", text: "ChatGPT でサインインしました" };
  if (result === "no-plan") return { tone: "info", text: "サインインしました。ただしこのアカウントでは ChatGPT プランを他のアプリで使えないため、AI 機能は使えません" };
  return { tone: "error", text: "ChatGPT でサインインできませんでした: 結果を確認できません" };
}

/** 状態表示の一行説明 */
export function describeDesktopAccount(v: DesktopAccountView): string {
  switch (v.kind) {
    case "loading": return "確認中…";
    case "signedOut": return "未サインイン";
    case "signedIn": return "サインイン済み（ChatGPT プランを利用できます）";
    case "noPlan": return "このアカウントでは ChatGPT プランを利用できません";
    case "reauth": return "再認証が必要です。もう一度サインインしてください";
  }
}

export const DESKTOP_ACCOUNT_CHANGED = "dc-designer:desktop-account-changed";
