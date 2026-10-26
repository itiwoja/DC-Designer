/**
 * 製品版の資格情報ストア（EXE-FR-003）。main だけが持ち、safeStorage（Windows では DPAPI）で暗号化した
 * ciphertext だけを <userRoot>/secrets/ に置く。暗号化できないときは平文で保存しない。
 * electron は import しない（safeStorage 互換の値を渡す）ので vitest で確かめられる
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { SecretState } from "./protocol";

/** safeStorage 互換 */
export interface SecretCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

/** 保存できる資格情報（固定）。値は上限バイト数（UTF-8） */
export const SECRET_CATALOG = {
  openrouter: { apiKey: 4096 },
  openai: { apiKey: 4096 },
  gemini: { apiKey: 4096 },
  chatgpt: { oauth: 65536 },
} as const;

export type SecretErrorCode = "INVALID_ARGUMENT" | "ENCRYPTION_UNAVAILABLE" | "WRITE_FAILED";

export type SecretEntry = { secretRef: string; providerId: string; kind: string; state: SecretState };

/** 結果は値で返す。value は get だけが返す（画面向けの応答には使わない） */
export type SecretResult = { ok: boolean; state: SecretState; secretRef?: string; value?: string; code?: SecretErrorCode };

export const secretRefOf = (providerId: string, kind: string) => `${providerId}/${kind}`;

/** カタログにある組み合わせなら上限バイト数を返す */
function limitOf(providerId: unknown, kind: unknown): number | undefined {
  if (typeof providerId !== "string" || typeof kind !== "string") return undefined;
  if (!Object.hasOwn(SECRET_CATALOG, providerId)) return undefined;
  const kinds = SECRET_CATALOG[providerId as keyof typeof SECRET_CATALOG] as Record<string, number>;
  return Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
}

export function parseSecretRef(ref: unknown): { providerId: string; kind: string } | null {
  if (typeof ref !== "string") return null;
  const [providerId, kind, ...rest] = ref.split("/");
  if (rest.length || limitOf(providerId, kind) === undefined) return null;
  return { providerId, kind };
}

function validValue(providerId: string, kind: string, value: unknown): value is string {
  const max = limitOf(providerId, kind);
  if (max === undefined || typeof value !== "string" || value.length === 0) return false;
  if (Buffer.byteLength(value) > max) return false;
  if (providerId === "chatgpt") {
    try {
      const j = JSON.parse(value);
      return !!j && typeof j === "object" && !Array.isArray(j);
    } catch { return false; }
  }
  return true;
}

export function createSecretStore(deps: { dir: string; crypto: SecretCrypto }) {
  const fileOf = (providerId: string, kind: string) => path.join(deps.dir, `${providerId}.${kind}.bin`);

  /** ciphertext を読む。無ければ null */
  function readCipher(file: string): Buffer | null {
    try { return readFileSync(file); } catch { return null; }
  }

  function decrypt(providerId: string, kind: string): { state: SecretState; value?: string } {
    const cipher = readCipher(fileOf(providerId, kind));
    if (!cipher) return { state: "unset" };
    try {
      if (!deps.crypto.isEncryptionAvailable()) return { state: "reauthRequired" };
      return { state: "configured", value: deps.crypto.decryptString(cipher) };
    } catch {
      return { state: "reauthRequired" };
    }
  }

  const bad = (): SecretResult => ({ ok: false, state: "unset", code: "INVALID_ARGUMENT" });

  /** tmp に書いてから置き換える。失敗しても既存の値は残る */
  function set(providerId: unknown, kind: unknown, value: unknown): SecretResult {
    if (typeof providerId !== "string" || typeof kind !== "string" || !validValue(providerId, kind, value)) return bad();
    const secretRef = secretRefOf(providerId, kind);
    const before = decrypt(providerId, kind).state;
    let cipher: Buffer;
    try {
      if (!deps.crypto.isEncryptionAvailable()) return { ok: false, state: before, secretRef, code: "ENCRYPTION_UNAVAILABLE" };
      cipher = deps.crypto.encryptString(value);
    } catch {
      return { ok: false, state: before, secretRef, code: "ENCRYPTION_UNAVAILABLE" };
    }
    const file = fileOf(providerId, kind);
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      mkdirSync(deps.dir, { recursive: true });
      writeFileSync(tmp, cipher, { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      try { unlinkSync(tmp); } catch { /* tmp が無ければ何もしない */ }
      return { ok: false, state: before, secretRef, code: "WRITE_FAILED" };
    }
    return { ok: true, state: "configured", secretRef };
  }

  /** 未登録でも unset */
  function remove(secretRef: unknown): SecretResult {
    const p = parseSecretRef(secretRef);
    if (!p) return bad();
    try {
      unlinkSync(fileOf(p.providerId, p.kind));
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
        return { ok: false, state: decrypt(p.providerId, p.kind).state, secretRef: secretRef as string, code: "WRITE_FAILED" };
      }
    }
    return { ok: true, state: "unset", secretRef: secretRef as string };
  }

  /** main 内部と worker への受け渡し用。復号できなければ reauthRequired（ok:false） */
  function get(providerId: unknown, kind: unknown): SecretResult {
    if (typeof providerId !== "string" || typeof kind !== "string" || limitOf(providerId, kind) === undefined) return bad();
    const r = decrypt(providerId, kind);
    const secretRef = secretRefOf(providerId, kind);
    return r.state === "reauthRequired" ? { ok: false, state: r.state, secretRef } : { ok: true, state: r.state, secretRef, ...(r.value !== undefined ? { value: r.value } : {}) };
  }

  /** カタログ全件の状態。値は返さない */
  function status(): SecretEntry[] {
    const out: SecretEntry[] = [];
    for (const [providerId, kinds] of Object.entries(SECRET_CATALOG)) {
      for (const kind of Object.keys(kinds)) out.push({ secretRef: secretRefOf(providerId, kind), providerId, kind, state: decrypt(providerId, kind).state });
    }
    return out;
  }

  return { set, remove, get, status };
}

export type SecretStore = ReturnType<typeof createSecretStore>;
