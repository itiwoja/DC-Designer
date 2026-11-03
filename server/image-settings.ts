import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { httpError } from "./http-error";
import { PINNED_CODEX } from "./codex-pinned";
import { dataDir, isDesktopMode as isDesktop } from "./env";

/** 画像生成まわりの設定（画面の設定から保存。空文字＝既定） */
export type ImageSettings = { comfyuiUrl: string; codexPath: string };

export const DEFAULT_COMFYUI_URL = "http://127.0.0.1:8188";

/** image-settings.json の場所（呼び出しごとに dataDir() を読む） */
const settingsFile = () => join(dataDir(), "image-settings.json");

/** 保存済みの設定。ファイルが無い・壊れている・型が違う項目は空文字（既定）として扱う */
export function readImageSettings(): ImageSettings {
  try {
    const f = settingsFile();
    if (!existsSync(f)) return { comfyuiUrl: "", codexPath: "" };
    const j = JSON.parse(readFileSync(f, "utf8"));
    return {
      comfyuiUrl: typeof j?.comfyuiUrl === "string" ? j.comfyuiUrl : "",
      codexPath: typeof j?.codexPath === "string" ? j.codexPath : "",
    };
  } catch {
    return { comfyuiUrl: "", codexPath: "" };
  }
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/** ComfyUI の URL を検証して正規化する（空文字はそのまま。ループバックの http(s) の origin だけ） */
function validateComfyUrl(v: string): string {
  const s = v.trim();
  if (!s) return "";
  const bad = () => httpError(400, "ComfyUI の URL は http://127.0.0.1:8188 のように、この PC（127.0.0.1・localhost・[::1]）の http(s) アドレスだけ指定できます");
  if (/[?#\s]/.test(s)) throw bad();
  let url: URL;
  try { url = new URL(s); } catch { throw bad(); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw bad();
  if (url.username || url.password) throw bad();
  if (!LOOPBACK_HOSTS.includes(url.hostname)) throw bad();
  if (url.pathname !== "/") throw bad();
  return url.origin;
}

/** Codex の実行ファイル名（Windows は codex.exe、それ以外は codex） */
export const codexExeName = () => (process.platform === "win32" ? "codex.exe" : "codex");

/** このアプリが入れる Codex CLI の置き場所（製品版だけ。<userRoot>/tools/codex）。版ごとのフォルダに codex.exe を置く */
export const appCodexDir = (): string | undefined => {
  const root = process.env.DC_DESIGNER_USER_ROOT;
  return root ? join(root, "tools", "codex") : undefined;
};

/** このアプリが入れた（入れる）Codex CLI の実行ファイル。版は server/codex-pinned.ts の固定版 */
export const appCodexExe = (version = PINNED_CODEX.version): string | undefined => {
  const dir = appCodexDir();
  return dir ? join(dir, version, codexExeName()) : undefined;
};

/** Codex のパスを検証する（空文字はそのまま。絶対パスで、ファイル名が codex.exe / codex のものだけ） */
function validateCodexPath(v: string): string {
  const s = v.trim();
  if (!s) return "";
  const bad = () => httpError(400, `Codex のパスは、${codexExeName()} の絶対パスを指定してください`);
  if (s.length > 500 || /[\0-\x1f]/.test(s)) throw bad();
  const win = process.platform === "win32";
  const p = win ? win32 : posix;
  if (!p.isAbsolute(s)) throw bad();
  const name = p.basename(s);
  if (win ? name.toLowerCase() !== "codex.exe" : name !== "codex") throw bad();
  return s;
}

/** 設定を保存する。渡した項目だけ更新し、検証に通らなければ 400。保存後の設定を返す */
export function updateImageSettings(body: unknown): ImageSettings {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  for (const k of ["comfyuiUrl", "codexPath"]) {
    if (b[k] !== undefined && typeof b[k] !== "string") throw httpError(400, `${k} は文字列で指定してください`);
  }
  const next = readImageSettings();
  if (b.comfyuiUrl !== undefined) next.comfyuiUrl = validateComfyUrl(b.comfyuiUrl as string);
  if (b.codexPath !== undefined) next.codexPath = validateCodexPath(b.codexPath as string);
  const f = settingsFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + ".tmp", JSON.stringify(next));
  renameSync(f + ".tmp", f);
  return next;
}

/** ComfyUI の接続先（末尾スラッシュ付き）。製品版は設定 → 既定。開発版は環境変数 → 設定 → 既定 */
export function comfyBaseUrl(): string {
  const saved = readImageSettings().comfyuiUrl;
  const raw = isDesktop() ? saved : process.env.COMFYUI_URL || saved;
  return (raw || DEFAULT_COMFYUI_URL).replace(/\/?$/, "/");
}
