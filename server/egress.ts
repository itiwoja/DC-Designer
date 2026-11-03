/**
 * 製品版 worker の外部通信ゲート（EXE-FR-004 / EXE-NFR）。global fetch を包み、既定拒否で目的別の許可表に合うものだけ通す。
 * worker の外部通信は global fetch だけ（node:http・WebSocket は使わない）なので、ここを通らない通信は無い。
 * 開発版（DC_DESIGNER_DESKTOP が無い）では包まない。URL の query・本文はエラーにもログにも出さない
 */
export type EgressPurpose = "fonts" | "auth" | "ai" | "image" | "tools";

import { CODEX_ASSET_HOSTS, CODEX_RELEASE_HOST, codexReleasePath, PINNED_CODEX } from "./codex-pinned";
import { isDesktopMode } from "./env";

export class EgressDeniedError extends Error {
  readonly code = "EGRESS_DENIED" as const;
  constructor() { super("許可されていない外部通信を止めました"); }
}

type Rule = {
  purpose: EgressPurpose;
  method: "GET" | "POST";
  host: string;
  /** exact は完全一致、prefix は接頭辞 */
  path: { exact: string } | { prefix: string };
  /** query を許すか（フォントの CSS だけ） */
  query?: true;
  /** 本人の承認1回につき1回だけ通す（許可を消費する） */
  once?: true;
  /** この PC のループバック（ComfyUI）だけに許す規則。http・任意ポートを許す。host は LOOPBACK_HOSTS のどれか */
  loopback?: true;
};

const AI_HOST = "api.openai.com";
const AI_RESPONSES_PATH = "/v1/responses";

const AUTH_HOST = "auth.openai.com";

const GEMINI_HOST = "generativelanguage.googleapis.com";

/** URL の hostname で見たループバック（IPv6 は角括弧つき）。ComfyUI は利用者の PC の中だけ */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;
/** 画像生成：ComfyUI のループバック規則（Codex CLI は子プロセスで動き fetch を通らないので、ここでは扱わない） */
const comfyRules: Rule[] = LOOPBACK_HOSTS.flatMap((host): Rule[] => [
  { purpose: "image", method: "GET", host, path: { exact: "/object_info/CheckpointLoaderSimple" }, loopback: true },
  { purpose: "image", method: "GET", host, path: { prefix: "/history/" }, loopback: true },
  { purpose: "image", method: "GET", host, path: { exact: "/view" }, query: true, loopback: true },
  { purpose: "image", method: "POST", host, path: { exact: "/prompt" }, loopback: true },
]);

/**
 * Codex CLI の取得（server/codex-setup.ts）：固定版のファイルの path だけ。github.com は転送（302）を返し、
 * 呼び出し側が転送先のホストを検証してから取りに行く（転送先は署名つきの query が付く）
 */
const codexRules: Rule[] = [
  ...Object.values(PINNED_CODEX.assets).map((a): Rule => ({ purpose: "tools", method: "GET", host: CODEX_RELEASE_HOST, path: { exact: codexReleasePath(a) } })),
  ...CODEX_ASSET_HOSTS.map((host): Rule => ({ purpose: "tools", method: "GET", host, path: { prefix: "/github-production-release-asset/" }, query: true })),
];

/** 許可表。auth の path は chatgpt-auth.ts の JWKS_URL / TOKEN_URL / REVOKE_URL と一致する（tests/egress.test.ts で確かめる） */
export const EGRESS_RULES: readonly Rule[] = [
  { purpose: "fonts", method: "GET", host: "fonts.googleapis.com", path: { prefix: "/css2" }, query: true },
  { purpose: "fonts", method: "GET", host: "fonts.gstatic.com", path: { prefix: "/s/" }, query: true },
  { purpose: "auth", method: "GET", host: AUTH_HOST, path: { exact: "/.well-known/jwks.json" } },
  { purpose: "auth", method: "POST", host: AUTH_HOST, path: { exact: "/api/accounts/oauth/token" } },
  { purpose: "auth", method: "POST", host: AUTH_HOST, path: { exact: "/api/accounts/oauth/revoke" } },
  { purpose: "ai", method: "GET", host: AI_HOST, path: { exact: "/v1/models" } },
  { purpose: "ai", method: "POST", host: AI_HOST, path: { exact: AI_RESPONSES_PATH }, once: true },
  // 画像生成：Gemini（server/imagegen.ts の generateGemini）
  { purpose: "image", method: "POST", host: GEMINI_HOST, path: { exact: "/v1beta/interactions" } },
  ...comfyRules,
  ...codexRules,
];

/** 一回分の許可の有効期間（承認から送信までの間だけ） */
export const EGRESS_PERMIT_TTL_MS = 60_000;
const MAX_PERMITS = 32;

export type EgressGate = {
  fetch: typeof fetch;
  /** AI 送信（POST /v1/responses）を1回だけ通す許可を足す（承認とハッシュ一致を確かめた直後に呼ぶ） */
  allowAiSendOnce(): void;
};

export function createEgressGate(realFetch: typeof fetch, opts: { now?: () => number; permitTtlMs?: number } = {}): EgressGate {
  const now = opts.now ?? Date.now;
  const ttl = opts.permitTtlMs ?? EGRESS_PERMIT_TTL_MS;
  /** 許可の失効時刻 */
  let permits: number[] = [];

  const prune = () => { const t = now(); permits = permits.filter((x) => x > t); };

  function matches(url: URL, method: string): Rule | undefined {
    // 正規化後（URL の解釈後）の https・host・path で照合する。資格情報つき URL・別ポートは拒否
    // （ループバック規則だけは http・任意ポートも許す。資格情報は同じく拒否）
    if (url.username || url.password) return undefined;
    const plain = url.protocol === "https:" && url.port === "";
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return EGRESS_RULES.find((r) =>
      (r.loopback ? true : plain) &&
      r.method === method && r.host === url.hostname &&
      ("exact" in r.path ? url.pathname === r.path.exact : url.pathname.startsWith(r.path.prefix)) &&
      (r.query || url.search === ""),
    );
  }

  const gated: typeof fetch = (input, init) => {
    let url: URL;
    let method: string;
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      url = new URL(raw);
      method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    } catch {
      return Promise.reject(new EgressDeniedError());
    }
    const rule = matches(url, method);
    if (!rule) return Promise.reject(new EgressDeniedError());
    if (rule.once) {
      prune();
      if (!permits.length) return Promise.reject(new EgressDeniedError());
      permits.shift();
    }
    // リダイレクトは追わない（manual を指定した呼び出し側が自分で Location を検証する）。Cookie・Referer は付けない
    const redirect = init?.redirect === "manual" ? "manual" : "error";
    return realFetch(input, { ...init, redirect, credentials: "omit", referrer: "" });
  };

  return {
    fetch: gated,
    allowAiSendOnce() { prune(); if (permits.length < MAX_PERMITS) permits.push(now() + ttl); },
  };
}

let installed: EgressGate | null = null;

/** 製品版の worker だけ globalThis.fetch を包む（二重には包まない）。包んだら true */
export function installEgress(): boolean {
  if (!isDesktopMode() || installed) return false;
  installed = createEgressGate(globalThis.fetch.bind(globalThis));
  globalThis.fetch = installed.fetch;
  return true;
}

/** 承認済みの AI 送信を1回通す。ゲートを包んでいない（開発版）なら何もしない */
export function allowAiSendOnce(): void { installed?.allowAiSendOnce(); }

/** テスト用：包みを解いて globalThis.fetch を元に戻す */
export function uninstallEgressForTest(original: typeof fetch): void { installed = null; globalThis.fetch = original; }
