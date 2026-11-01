/**
 * 製品版の設定画面から Codex CLI を入れる・サインインする（2026-11-01）。
 * - 入れる：公式の GitHub リリースから固定版（server/codex-pinned.ts）の tar.gz を取り、sha256 が一致したときだけ
 *   <userRoot>/tools/codex/<版>/codex.exe に置く。通信は worker の外部通信ゲートを通る（github.com と転送先だけ許可）
 * - サインイン：見つかった codex.exe で `codex login` を shell なし・窓なしで起動する。利用者の既定の CODEX_HOME（~/.codex）に
 *   auth.json ができる（画像生成はそれを専用 CODEX_HOME へ写して使う）。ブラウザは Codex が開く
 */
import { createHash } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { CODEX_ASSET_HOSTS, CODEX_RELEASE_HOST, codexReleasePath, PINNED_CODEX, pinnedCodexAsset, type PinnedCodexAsset } from "./codex-pinned";
import { appCodexDir, appCodexExe, readImageSettings, updateImageSettings } from "./image-settings";
import { ImageGenError } from "./imagegen-error";
import { CODEX_ENV_KEYS, isFile, killTree, resolveCodexExe, userAuthFile } from "./imagegen";

/** 準備の段階：download（取得。done/total はバイト）→ verify（照合）→ install（配置）／ login（ブラウザでのサインイン待ち） */
export type SetupStep = "download" | "verify" | "install" | "login";
export type SetupProgress = { phase: "setup"; step: SetupStep; done?: number; total?: number; url?: string };
export type OnSetupProgress = (p: SetupProgress) => void;

const isDesktop = () => process.env.DC_DESIGNER_DESKTOP === "1";

/** tar の中の実行ファイルの上限（Codex は 300MB 前後） */
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

const downloadFailed = (detail?: string) =>
  new ImageGenError("codex_download_failed", "Codex CLI をダウンロードできませんでした。インターネットに接続できているか確かめて、もう一度試してください", detail);
const verifyFailed = (detail?: string) =>
  new ImageGenError("codex_verify_failed", "ダウンロードした Codex CLI が公式のものと一致しませんでした。もう一度試してください", detail);

/**
 * tar を逐次読み、名前が entry の通常ファイルだけを file へ書き出す Writable。ほかの項目（pax・GNU の長い名前など）は読み飛ばす。
 * 中身の正しさは呼び出し側が tar.gz 全体の sha256 で確かめる
 */
class TarEntryWriter extends Writable {
  private buf: Buffer = Buffer.alloc(0);
  private remaining = 0;
  private pad = 0;
  private writing = false;
  private ended = false;
  found = false;
  written = 0;

  constructor(private entry: string, private file: FileHandle) { super(); }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.consume(chunk).then(() => cb(), cb);
  }

  private async consume(chunk: Buffer): Promise<void> {
    let data = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.buf = Buffer.alloc(0);
    while (data.length && !this.ended) {
      if (this.remaining > 0) {
        const n = Math.min(this.remaining, data.length);
        if (this.writing) { await this.file.write(data.subarray(0, n)); this.written += n; }
        this.remaining -= n;
        data = data.subarray(n);
        continue;
      }
      if (this.pad > 0) {
        const n = Math.min(this.pad, data.length);
        this.pad -= n;
        data = data.subarray(n);
        continue;
      }
      if (data.length < 512) { this.buf = Buffer.from(data); return; }
      const header = data.subarray(0, 512);
      data = data.subarray(512);
      if (header.every((b) => b === 0)) { this.ended = true; return; }
      const str = (off: number, len: number) => { const s = header.subarray(off, off + len); const z = s.indexOf(0); return (z >= 0 ? s.subarray(0, z) : s).toString("utf8"); };
      if (header[124] & 0x80) throw verifyFailed("tar の大きさの形式が想定外です");
      const size = parseInt(str(124, 12).trim() || "0", 8);
      if (!Number.isFinite(size) || size < 0) throw verifyFailed("tar の見出しが壊れています");
      const type = header[156];
      const ustar = str(257, 6) === "ustar";
      const prefix = ustar && header.subarray(257, 263).toString("latin1") === "ustar\0" ? str(345, 155) : "";
      const name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
      const regular = type === 0 || type === 0x30; // '\0' か '0'
      this.writing = regular && basename(name) === this.entry && !this.found;
      if (this.writing) {
        if (size > MAX_ENTRY_BYTES) throw verifyFailed("実行ファイルが大きすぎます");
        this.found = true;
      }
      this.remaining = size;
      this.pad = (512 - (size % 512)) % 512;
      if (size === 0) this.writing = false;
    }
  }
}

let installing = false;

export type InstallDeps = { fetch?: typeof fetch; platform?: string; arch?: string; /** テスト用：固定版の代わりに使うファイル */ asset?: PinnedCodexAsset };

/**
 * 固定版の Codex CLI を入れる。入れ終えた（すでにある）実行ファイルの場所・版と、サインイン済みかを返す。
 * 途中で中止・失敗したら、書きかけのファイルは消す
 */
export async function installCodex(onProgress: OnSetupProgress, signal: AbortSignal, deps: InstallDeps = {}): Promise<{ path: string; version: string; signedIn: boolean }> {
  const asset = deps.asset ?? pinnedCodexAsset(deps.platform, deps.arch);
  const dir = appCodexDir();
  const exe = appCodexExe();
  if (!isDesktop() || !asset || !dir || !exe)
    throw new ImageGenError("codex_install_unsupported", "この PC ではアプリから Codex CLI を入れられません。Codex CLI を自分で入れて、設定画面で場所を指定してください", undefined, 400);
  if (isFile(exe)) return finishInstall(exe);
  if (installing) throw new ImageGenError("codex_install_busy", "Codex CLI を入れている途中です。終わるまでお待ちください", undefined, 409);
  installing = true;
  const versionDir = join(dir, PINNED_CODEX.version);
  const tmp = join(versionDir, `codex.exe.${process.pid}.download`);
  try {
    mkdirSync(versionDir, { recursive: true });
    const res = await openDownload(deps.fetch ?? fetch, asset, signal);
    const hash = createHash("sha256");
    let done = 0;
    onProgress({ phase: "setup", step: "download", done, total: asset.size });
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        done += chunk.length;
        if (done > asset.size) return cb(verifyFailed("想定より大きなファイルが届きました"));
        hash.update(chunk);
        onProgress({ phase: "setup", step: "download", done, total: asset.size });
        cb(null, chunk);
      },
    });
    const file = await open(tmp, "w", 0o755);
    const writer = new TarEntryWriter(asset.entry, file);
    try {
      await pipeline(Readable.fromWeb(res.body as any), counter, createGunzip(), writer, { signal });
    } catch (e: any) {
      if (signal.aborted) throw e;
      if (e instanceof ImageGenError) throw e;
      // 途中で切れた・gzip が壊れている（届いた中身が違う）
      throw done < asset.size ? downloadFailed(e?.message) : verifyFailed(e?.message);
    } finally {
      await file.close();
    }
    onProgress({ phase: "setup", step: "verify" });
    const digest = hash.digest("hex");
    if (done !== asset.size || digest !== asset.sha256) throw verifyFailed(`size ${done} / sha256 ${digest}`);
    if (!writer.found || !writer.written) throw verifyFailed("tar の中に実行ファイルがありません");
    onProgress({ phase: "setup", step: "install" });
    renameSync(tmp, exe);
    removeOldVersions(dir);
    return finishInstall(exe);
  } finally {
    rmSync(tmp, { force: true });
    installing = false;
  }
}

/** 入れ終えたあと：設定に残っている存在しないパスは消す（自動検出で今入れたものが見つかるように） */
function finishInstall(exe: string): { path: string; version: string; signedIn: boolean } {
  const configured = readImageSettings().codexPath;
  if (configured && !isFile(configured)) updateImageSettings({ codexPath: "" });
  // signedIn が false なら、画面は続けてサインインを始める
  return { path: exe, version: PINNED_CODEX.version, signedIn: isFile(userAuthFile()) };
}

/** ほかの版のフォルダを消す（使用中などで消せなくても続ける） */
function removeOldVersions(dir: string): void {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== PINNED_CODEX.version) rmSync(join(dir, e.name), { recursive: true, force: true });
    }
  } catch { /* 消せなくても入れた版は使える */ }
}

/** github.com のリリースを取り、転送先（release-assets.githubusercontent.com など）を検証してから本体を取る */
async function openDownload(doFetch: typeof fetch, asset: PinnedCodexAsset, signal: AbortSignal): Promise<Response> {
  const url = `https://${CODEX_RELEASE_HOST}${codexReleasePath(asset)}`;
  const get = async (u: string) => {
    try {
      return await doFetch(u, { redirect: "manual", signal });
    } catch (e: any) {
      if (signal.aborted) throw e;
      throw downloadFailed(e?.cause?.message ?? e?.message);
    }
  };
  let res = await get(url);
  for (let hops = 0; res.status >= 300 && res.status < 400; hops++) {
    const loc = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (!loc || hops >= 2) throw downloadFailed(`転送が想定外です（HTTP ${res.status}）`);
    let next: URL;
    try { next = new URL(loc, url); } catch { throw downloadFailed("転送先の URL が正しくありません"); }
    if (next.protocol !== "https:" || next.port || next.username || next.password || !(CODEX_ASSET_HOSTS as readonly string[]).includes(next.hostname))
      throw downloadFailed(`想定外の転送先です（${next.hostname}）`);
    res = await get(next.href);
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw downloadFailed(`HTTP ${res.status}`);
  }
  return res;
}

// ---------- サインイン（codex login） ----------

/** `codex login` が出す認可 URL（ブラウザが開かないときに画面から開けるようにする） */
const AUTH_URL_RE = /https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s"'<>]+/;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOGIN_TAIL = 4 * 1024;

let loggingIn = false;

/**
 * サインイン待ちのあいだ、同じ進み具合を送り直す間隔。main は worker の応答を fetch（undici）で読み、
 * 本文が 300 秒届かないと切るため、ブラウザでのサインインに時間がかかっても切れないようにする
 */
const LOGIN_HEARTBEAT_MS = 30_000;

export type LoginDeps = { spawn?: typeof nodeSpawn; timeoutMs?: number; heartbeatMs?: number };

/** 見つかった codex.exe で `codex login` を実行し、サインインが済むまで待つ */
export async function loginCodex(onProgress: OnSetupProgress, signal: AbortSignal, deps: LoginDeps = {}): Promise<{ signedIn: true }> {
  const exe = resolveCodexExe();
  if (!exe) throw new ImageGenError("not_found", "Codex CLI が見つかりません。先に「Codex CLI を入れる」で入れてください", undefined, 400);
  if (loggingIn) throw new ImageGenError("codex_login_busy", "サインインの途中です。ブラウザでサインインを済ませてください", undefined, 409);
  loggingIn = true;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    let last: SetupProgress = { phase: "setup", step: "login" };
    const emit = (p: SetupProgress) => { last = p; onProgress(p); };
    emit(last);
    heartbeat = setInterval(() => onProgress(last), deps.heartbeatMs ?? LOGIN_HEARTBEAT_MS);
    const env: NodeJS.ProcessEnv = {};
    // 利用者の既定の CODEX_HOME に auth.json を作る（専用 CODEX_HOME は画像生成の実行のときだけ使う）
    for (const k of [...CODEX_ENV_KEYS, "CODEX_HOME"]) if (process.env[k] !== undefined) env[k] = process.env[k];
    await runLogin(deps.spawn ?? nodeSpawn, exe, env, signal, deps.timeoutMs ?? LOGIN_TIMEOUT_MS, (url) => emit({ phase: "setup", step: "login", url }));
    if (!isFile(userAuthFile())) throw new ImageGenError("codex_login_failed", "Codex にサインインできませんでした。もう一度試してください", "auth.json が作られませんでした");
    return { signedIn: true };
  } finally {
    clearInterval(heartbeat);
    loggingIn = false;
  }
}

function runLogin(
  spawn: typeof nodeSpawn, exe: string, env: NodeJS.ProcessEnv, signal: AbortSignal, timeoutMs: number, onUrl: (url: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(loginCanceled());
    let child: ChildProcess;
    try {
      child = spawn(exe, ["login"], { cwd: tmpdir(), env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (e: any) {
      return reject(new ImageGenError("spawn", "Codex CLI を起動できませんでした。設定画面で Codex の状態を確かめてください", e?.message));
    }
    let tail = "";
    let urlSent = false;
    const onData = (d: Buffer) => {
      tail = (tail + d.toString()).slice(-LOGIN_TAIL);
      if (urlSent) return;
      const m = AUTH_URL_RE.exec(tail);
      if (m) { urlSent = true; onUrl(m[0]); }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const stop = (e: ImageGenError) => { killTree(child, "SIGTERM"); finish(() => reject(e)); };
    const onAbort = () => stop(loginCanceled());
    const timer = setTimeout(() => stop(new ImageGenError("codex_login_timeout", "サインインが時間内に終わりませんでした。もう一度試してください", undefined, 504)), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => finish(() => reject(new ImageGenError("spawn", "Codex CLI を起動できませんでした。設定画面で Codex の状態を確かめてください", e.message))));
    child.on("close", (code) => finish(() => {
      if (code === 0) resolve();
      // 出力の末尾（パスを含みうる）は開発版・ログ用の詳細にだけ入れる
      else reject(new ImageGenError("codex_login_failed", "Codex にサインインできませんでした。もう一度試してください", `exit ${code}: ${tail.replace(AUTH_URL_RE, "<url>").slice(-300)}`));
    }));
  });
}

const loginCanceled = () => new ImageGenError("codex_login_canceled", "サインインを中止しました", undefined, 499);
