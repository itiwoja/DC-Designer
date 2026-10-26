/**
 * サーバーのコードが資格情報を読み書きする口（EXE-API-006）。
 * 製品版は main に問い合わせる実装（desktop-worker が登録）、開発版は process.env と chatgpt.json を使う既定実装
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MainToWorker, SecretState, WorkerToMain } from "../desktop/protocol";

export interface SecretBackend {
  get(providerId: string, kind: string): Promise<string | undefined>;
  set(providerId: string, kind: string, value: string): Promise<void>;
  remove(providerId: string, kind: string): Promise<void>;
  /** 同期。状態のキャッシュ（開発版は env・ファイルの有無）から答える */
  has(providerId: string, kind: string): boolean;
}

/** 資格情報が使えない（再サインインや再入力が要る）。値・パスは含めない */
export class SecretError extends Error {
  constructor(readonly state: SecretState | "failed", message: string) { super(message); }
}

// ---- 開発版の既定実装 ----

const ENV_KEYS: Record<string, string> = {
  "openrouter/apiKey": "OPENROUTER_API_KEY",
  "openai/apiKey": "OPENAI_API_KEY",
  "gemini/apiKey": "GEMINI_API_KEY",
};
const OAUTH = "chatgpt/oauth";
const configDir = () => process.env.DC_DESIGNER_CONFIG_DIR || join(homedir(), ".config", "dc-designer");
const oauthFile = () => join(configDir(), "chatgpt.json");

export const devBackend: SecretBackend = {
  async get(p, k) {
    const ref = `${p}/${k}`;
    if (ENV_KEYS[ref]) return process.env[ENV_KEYS[ref]] || undefined;
    if (ref !== OAUTH) return undefined;
    try { return readFileSync(oauthFile(), "utf8"); } catch { return undefined; }
  },
  async set(p, k, value) {
    if (`${p}/${k}` !== OAUTH) throw new SecretError("failed", "開発版では .env で設定します");
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const tmp = `${oauthFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, value, { mode: 0o600 });
    renameSync(tmp, oauthFile());
  },
  async remove(p, k) {
    if (`${p}/${k}` !== OAUTH) throw new SecretError("failed", "開発版では .env で設定します");
    try { unlinkSync(oauthFile()); } catch { /* 無ければ何もしない */ }
  },
  has(p, k) {
    const ref = `${p}/${k}`;
    if (ENV_KEYS[ref]) return !!process.env[ENV_KEYS[ref]];
    return ref === OAUTH && existsSync(oauthFile());
  },
};

// ---- 製品版：main への問い合わせ ----

export type ParentPortLike = {
  on(event: "message", cb: (e: { data: unknown }) => void): void;
  postMessage(msg: WorkerToMain): void;
};

type SecretQuery =
  | { type: "secret-get"; providerId: string; kind: string }
  | { type: "secret-set"; providerId: string; kind: string; value: string }
  | { type: "secret-remove"; providerId: string; kind: string };

const REQUEST_TIMEOUT_MS = 10_000;

/** parentPort 越しに main へ問い合わせる実装。states は worker 起動時（init）に受け取った状態一覧 */
export function createMainBackend(port: ParentPortLike, initial: Record<string, SecretState>, timeoutMs = REQUEST_TIMEOUT_MS): SecretBackend {
  const states = new Map<string, SecretState>(Object.entries(initial));
  const waiting = new Map<string, (m: Extract<MainToWorker, { type: "secret-result" }>) => void>();
  let seq = 0;

  port.on("message", ({ data }) => {
    const m = data as MainToWorker | null;
    if (m?.type === "secret-result") waiting.get(m.requestId)?.(m);
    else if (m?.type === "secret-changed" && typeof m.secretRef === "string") states.set(m.secretRef, m.state);
  });

  function ask(msg: SecretQuery) {
    const requestId = `s${++seq}`;
    return new Promise<Extract<MainToWorker, { type: "secret-result" }>>((resolve, reject) => {
      const t = setTimeout(() => { waiting.delete(requestId); reject(new SecretError("failed", "資格情報の取得がタイムアウトしました")); }, timeoutMs);
      waiting.set(requestId, (m) => { clearTimeout(t); waiting.delete(requestId); resolve(m); });
      port.postMessage({ ...msg, requestId } as WorkerToMain);
    });
  }

  const track = (ref: string, r: Extract<MainToWorker, { type: "secret-result" }>) => { if (r.state) states.set(ref, r.state); };

  return {
    async get(p, k) {
      const r = await ask({ type: "secret-get", providerId: p, kind: k });
      track(`${p}/${k}`, r);
      if (r.state === "reauthRequired") throw new SecretError("reauthRequired", "保存済みの資格情報を読み出せません。設定し直してください");
      return r.ok && r.state === "configured" ? r.value : undefined;
    },
    async set(p, k, value) {
      const r = await ask({ type: "secret-set", providerId: p, kind: k, value });
      if (!r.ok) throw new SecretError("failed", "資格情報を保存できませんでした");
      track(`${p}/${k}`, r);
    },
    async remove(p, k) {
      const r = await ask({ type: "secret-remove", providerId: p, kind: k });
      if (!r.ok) throw new SecretError("failed", "資格情報を削除できませんでした");
      track(`${p}/${k}`, r);
    },
    has: (p, k) => states.get(`${p}/${k}`) === "configured",
  };
}

// ---- 公開 ----

let backend: SecretBackend = devBackend;
/** 製品版の worker が起動時に差し替える（テストは null で既定に戻す） */
export function setSecretBackend(b: SecretBackend | null): void { backend = b ?? devBackend; }

export const getSecret = (providerId: string, kind: string) => backend.get(providerId, kind);
export const setSecret = (providerId: string, kind: string, value: string) => backend.set(providerId, kind, value);
export const removeSecret = (providerId: string, kind: string) => backend.remove(providerId, kind);
export const hasSecret = (providerId: string, kind: string) => backend.has(providerId, kind);
