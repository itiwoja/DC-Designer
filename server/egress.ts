/**
 * 製品版 worker の外部通信ゲート（EXE-FR-004 / EXE-NFR）。global fetch を包み、既定拒否で目的別の許可表に合うものだけ通す。
 * worker の外部通信は global fetch だけ（node:http・WebSocket は使わない）なので、ここを通らない通信は無い。
 * 開発版（DC_DESIGNER_DESKTOP が無い）では包まない。URL の query・本文はエラーにもログにも出さない
 */
export type EgressPurpose = "fonts" | "auth" | "ai";

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
};

const AI_HOST = "api.openai.com";
const AI_RESPONSES_PATH = "/v1/responses";

const AUTH_HOST = "auth.openai.com";

/** 許可表。auth の path は chatgpt-auth.ts の JWKS_URL / TOKEN_URL / REVOKE_URL と一致する（tests/egress.test.ts で確かめる） */
export const EGRESS_RULES: readonly Rule[] = [
  { purpose: "fonts", method: "GET", host: "fonts.googleapis.com", path: { prefix: "/css2" }, query: true },
  { purpose: "fonts", method: "GET", host: "fonts.gstatic.com", path: { prefix: "/s/" }, query: true },
  { purpose: "auth", method: "GET", host: AUTH_HOST, path: { exact: "/.well-known/jwks.json" } },
  { purpose: "auth", method: "POST", host: AUTH_HOST, path: { exact: "/api/accounts/oauth/token" } },
  { purpose: "auth", method: "POST", host: AUTH_HOST, path: { exact: "/api/accounts/oauth/revoke" } },
  { purpose: "ai", method: "GET", host: AI_HOST, path: { exact: "/v1/models" } },
  { purpose: "ai", method: "POST", host: AI_HOST, path: { exact: AI_RESPONSES_PATH }, once: true },
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
    if (url.protocol !== "https:" || url.username || url.password || url.port !== "") return undefined;
    return EGRESS_RULES.find((r) =>
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
  if (process.env.DC_DESIGNER_DESKTOP !== "1" || installed) return false;
  installed = createEgressGate(globalThis.fetch.bind(globalThis));
  globalThis.fetch = installed.fetch;
  return true;
}

/** 承認済みの AI 送信を1回通す。ゲートを包んでいない（開発版）なら何もしない */
export function allowAiSendOnce(): void { installed?.allowAiSendOnce(); }

/** テスト用：包みを解いて globalThis.fetch を元に戻す */
export function uninstallEgressForTest(original: typeof fetch): void { installed = null; globalThis.fetch = original; }
