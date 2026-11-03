import type { Router } from "express";
import { FEEDBACK_RELAY_URL, parseFeedbackRequest, type FeedbackErrorResponse, type FeedbackResponse } from "../../desktop/feedbackRelay";
import { httpError } from "../http-error";
import { UserFacingError, type RouteHandlers } from "../route-handlers";

const RELAY_TIMEOUT_MS = 15_000;
const MAX_RELAY_MESSAGE = 200;
const UNAVAILABLE_MESSAGE = "いまは送れませんでした。時間をおいてもう一度お試しください";
const RATE_LIMITED_MESSAGE = "短い間に送りすぎています。しばらくしてからもう一度お試しください";

const unavailable = () => new UserFacingError(503, UNAVAILABLE_MESSAGE, "feedback_unavailable");

/** 送り先。開発版だけ環境変数で上書きできる（製品版は無視） */
function relayUrl(): string {
  const override = process.env.FEEDBACK_RELAY_URL;
  return process.env.DC_DESIGNER_DESKTOP !== "1" && override ? override : FEEDBACK_RELAY_URL;
}

/** 中継の 201 応答が {number: 正の整数, url: GitHub の URL} のときだけ通す */
function parseSuccess(v: unknown): FeedbackResponse | null {
  if (!v || typeof v !== "object") return null;
  const { number, url } = v as Record<string, unknown>;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  if (typeof url !== "string" || !url.startsWith("https://github.com/")) return null;
  return { number, url };
}

/** 429 の応答から利用者に見せる message を取る。形が違えば固定文言 */
async function rateLimitMessage(res: Response): Promise<string> {
  try {
    const { message } = (await res.json()) as Partial<FeedbackErrorResponse>;
    if (typeof message === "string" && message.length > 0 && message.length <= MAX_RELAY_MESSAGE) return message;
  } catch { /* 本文が JSON でなければ固定文言 */ }
  return RATE_LIMITED_MESSAGE;
}

/** 中継へ送って Issue の番号と URL を返す。失敗は利用者向けの文言で投げる（中継の本文・URL はログに出さない） */
async function sendToRelay(body: unknown, signal: AbortSignal): Promise<FeedbackResponse> {
  let res: Response;
  try {
    res = await fetch(relayUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(RELAY_TIMEOUT_MS)]),
    });
  } catch {
    throw unavailable();
  }
  if (res.status === 429) throw new UserFacingError(429, await rateLimitMessage(res), "feedback_rate_limited");
  if (res.status !== 201) throw unavailable();
  let json: unknown;
  try { json = await res.json(); } catch { throw unavailable(); }
  const ok = parseSuccess(json);
  if (!ok) throw unavailable();
  return ok;
}

/** 要望・不具合の送信（アプリのサーバー → 中継 → GitHub の Issue） */
export function registerFeedbackRoutes(app: Router, { route }: RouteHandlers) {
  app.post("/api/feedback", route(async (req, signal) => {
    const parsed = parseFeedbackRequest(req.body);
    if (!parsed) throw httpError(400, "送る内容の形が正しくありません");
    return sendToRelay(parsed, signal);
  }));
}
