/**
 * 要望・不具合の中継（Cloudflare Worker, Issue #77）。
 * アプリのサーバーから POST /v1/issues を受け、GitHub App のインストールトークンで GitHub の Issue を作る。
 * ブラウザからは呼ばないので CORS は付けない
 */
import {
  FEEDBACK_KIND_GITHUB_LABEL,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_LABEL,
  FEEDBACK_MAX_TITLE,
  FEEDBACK_RELAY_PATH,
  FEEDBACK_REPO,
  parseFeedbackRequest,
  type FeedbackEnv,
  type FeedbackErrorResponse,
  type FeedbackRequest,
  type FeedbackResponse,
} from "../../desktop/feedbackRelay";
import { getInstallationToken, readGithubAppConfig, type GithubAppEnv } from "./githubApp";
import { takeGlobalQuota, type QuotaNamespace } from "./quota";

export { FeedbackQuota } from "./quota";

/** Workers Rate Limiting バインディングの最小の型 */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env extends GithubAppEnv {
  PER_IP: RateLimit;
  GLOBAL: RateLimit;
  /** 全体の 1 時間・1 日あたりの上限（Durable Object） */
  QUOTA: QuotaNamespace;
}

/** 本文（JSON）の上限（バイト） */
export const MAX_REQUEST_BYTES = 32 * 1024;
const GITHUB_TIMEOUT_MS = 10_000;
/**
 * 1 回の送信にかける時間の上限（トークン取得・取り直しを含む）。
 * アプリのサーバーは 15 秒で諦めて「ブラウザの GitHub で送る」を出すので、それより先に必ず終える
 * （遅れて Issue ができ、利用者がもう一度送って 2 件になるのを防ぐ）
 */
export const RELAY_DEADLINE_MS = 12_000;

const MESSAGES = {
  invalid: "送る内容の形が正しくありません",
  rate_limited: "送信が多すぎます。少し時間をおいてから送ってください",
  unavailable: "いまは送れませんでした。時間をおいてもう一度お試しください",
} as const;

export type GitHubIssuePayload = { title: string; body: string; labels: string[] };

/**
 * 通知の悪用を防ぐため、@ の直後にゼロ幅スペースを入れてメンションを無効にする。
 * owner/repo#123 の形も、ほかのリポジトリに「参照されました」が残らないよう # の直後に入れる
 */
export function neutralizeMentions(s: string): string {
  return s.replace(/@/g, "@​").replace(/([\w.-]+\/[\w.-]+)#(?=\d)/g, "$1#​");
}

/** IP ごとの上限のキー。IPv6 は 1 契約に /64 が割り当てられるので、アドレスを替えて上限を逃れられないよう /64 にまとめる */
export function rateLimitKey(ip: string | null): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** アプリ内の feedback.ts の envSection と同じ書式 */
function envSection(env: FeedbackEnv): string {
  return [
    "---",
    "環境",
    `- アプリの版: ${env.appVersion || "不明"}`,
    `- 種類: ${env.desktop ? "製品版" : "開発版"}`,
    `- OS: ${env.os || "不明"}`,
  ].join("\n");
}

const FOOTER = "---\n_アプリ内の「要望・不具合を送る」から匿名で送られました。_";

/** 検証済みの要求から GitHub の Issue の中身を組み立てる（純粋関数） */
export function buildIssue(req: FeedbackRequest): GitHubIssuePayload {
  const title = neutralizeMentions(`[${FEEDBACK_KIND_LABELS[req.kind]}] ${req.title}`).slice(0, FEEDBACK_MAX_TITLE);
  const parts = [req.body];
  if (req.env) parts.push(envSection(req.env));
  parts.push(FOOTER);
  return {
    title,
    body: neutralizeMentions(parts.join("\n\n")),
    labels: [FEEDBACK_LABEL, FEEDBACK_KIND_GITHUB_LABEL[req.kind]],
  };
}

function json(status: number, data: FeedbackResponse | FeedbackErrorResponse, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

const fail = (status: number, error: FeedbackErrorResponse["error"]) => json(status, { error, message: MESSAGES[error] });

/** 本文を最大 MAX_REQUEST_BYTES まで読む。超えたら null */
async function readLimited(req: Request): Promise<string | null> {
  const declared = req.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_REQUEST_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** GitHub に Issue を作る。成功なら {number,url}、401 なら "unauthorized"、それ以外は null（エラー本文は返さない） */
async function createIssue(issue: GitHubIssuePayload, token: string, deadline: AbortSignal): Promise<FeedbackResponse | "unauthorized" | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${FEEDBACK_REPO}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dc-designer-feedback-relay",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(issue),
      signal: AbortSignal.any([deadline, AbortSignal.timeout(GITHUB_TIMEOUT_MS)]),
    });
    if (res.status === 401) {
      console.warn("GitHub API が 401 を返しました");
      return "unauthorized";
    }
    if (res.status !== 201) {
      console.warn(`GitHub API が ${res.status} を返しました`);
      return null;
    }
    const data = (await res.json()) as { number?: unknown; html_url?: unknown };
    if (typeof data.number !== "number" || typeof data.html_url !== "string" || !data.html_url.startsWith("https://github.com/")) {
      console.warn("GitHub API の応答の形が想定と違います");
      return null;
    }
    return { number: data.number, url: data.html_url };
  } catch (e) {
    console.warn(`GitHub API の呼び出しに失敗しました: ${e instanceof Error ? e.name : "unknown"}`);
    return null;
  }
}

/** トークンを取って Issue を作る。401 ならキャッシュを捨てて 1 回だけ取り直す */
async function createIssueAsApp(issue: GitHubIssuePayload, env: Env): Promise<FeedbackResponse | null> {
  const signal = AbortSignal.timeout(RELAY_DEADLINE_MS);
  let token = await getInstallationToken(env, { signal });
  if (!token) return null;
  let created = await createIssue(issue, token, signal);
  if (created === "unauthorized") {
    token = await getInstallationToken(env, { refresh: true, signal });
    if (!token) return null;
    created = await createIssue(issue, token, signal);
  }
  return created === "unauthorized" ? null : created;
}

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  if (new URL(req.url).pathname !== FEEDBACK_RELAY_PATH) return json(404, { error: "invalid", message: "見つかりません" });
  if (req.method !== "POST") return json(405, { error: "invalid", message: "POST だけ受け付けます" }, { Allow: "POST" });

  const ip = rateLimitKey(req.headers.get("CF-Connecting-IP"));
  const [perIp, global] = await Promise.all([env.PER_IP.limit({ key: ip }), env.GLOBAL.limit({ key: "all" })]);
  if (!perIp.success || !global.success) return fail(429, "rate_limited");

  const type = (req.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return json(415, { error: "invalid", message: "JSON で送ってください" });

  const text = await readLimited(req);
  if (text === null) return json(413, { error: "invalid", message: "送る内容が大きすぎます" });

  let parsed: FeedbackRequest | null = null;
  try {
    parsed = parseFeedbackRequest(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (!parsed) return fail(400, "invalid");

  if (!readGithubAppConfig(env)) {
    console.error("GitHub App の設定がありません");
    return fail(503, "unavailable");
  }
  // 中身が正しいものだけを全体の枠で数える（壊れた要求で枠を使い切られないように）
  if (!(await takeGlobalQuota(env.QUOTA))) return fail(503, "unavailable");
  const created = await createIssueAsApp(buildIssue(parsed), env);
  return created ? json(201, created) : fail(502, "unavailable");
}

export default {
  fetch: (req: Request, env: Env) => handleRequest(req, env),
};
