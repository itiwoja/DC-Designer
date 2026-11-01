import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { httpError } from "./http-error";

/** 画像生成まわりの設定（画面の設定から保存。空文字＝既定） */
export type ImageSettings = { comfyuiUrl: string; codexPath: string };

export const DEFAULT_COMFYUI_URL = "http://127.0.0.1:8188";

/** データの置き場所（server/chatgpt.ts の MODEL_FILE と同じ決め方。呼び出しごとに読む） */
export const dataDir = () => process.env.DATA_DIR || fileURLToPath(new URL("../data/", import.meta.url));
const settingsFile = () => join(dataDir(), "image-settings.json");

const isDesktop = () => process.env.DC_DESIGNER_DESKTOP === "1";

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
