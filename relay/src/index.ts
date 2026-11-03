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

/** Workers Rate Limiting バインディングの最小の型 */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env extends GithubAppEnv {
  PER_IP: RateLimit;
  GLOBAL: RateLimit;
}

/** 本文（JSON）の上限（バイト） */
export const MAX_REQUEST_BYTES = 32 * 1024;
const GITHUB_TIMEOUT_MS = 10_000;

const MESSAGES = {
  invalid: "送る内容の形が正しくありません",
  rate_limited: "送信が多すぎます。少し時間をおいてから送ってください",
  unavailable: "いまは送れませんでした。時間をおいてもう一度お試しください",
} as const;

export type GitHubIssuePayload = { title: string; body: string; labels: string[] };

/** 通知の悪用を防ぐため、@ の直後にゼロ幅スペースを入れてメンションを無効にする */
export function neutralizeMentions(s: string): string {
  return s.replace(/@/g, "@​");
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
async function createIssue(issue: GitHubIssuePayload, token: string): Promise<FeedbackResponse | "unauthorized" | null> {
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
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
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
  let token = await getInstallationToken(env);
  if (!token) return null;
  let created = await createIssue(issue, token);
  if (created === "unauthorized") {
    token = await getInstallationToken(env, { refresh: true });
    if (!token) return null;
    created = await createIssue(issue, token);
  }
  return created === "unauthorized" ? null : created;
}

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  if (new URL(req.url).pathname !== FEEDBACK_RELAY_PATH) return json(404, { error: "invalid", message: "見つかりません" });
  if (req.method !== "POST") return json(405, { error: "invalid", message: "POST だけ受け付けます" }, { Allow: "POST" });

  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
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
  const created = await createIssueAsApp(buildIssue(parsed), env);
  return created ? json(201, created) : fail(502, "unavailable");
}

export default {
  fetch: (req: Request, env: Env) => handleRequest(req, env),
};
