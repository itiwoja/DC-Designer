import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { userInfo } from "node:os";

export type LeaseResult = { ok: true; release: () => Promise<void> } | { ok: false; reason: "timeout" | "denied" };

const RETRY_MS = 200;

/**
 * userRoot ごとの排他 lease。名前付きパイプ（テストでは UNIX ソケット）を listen している間だけ保持する。
 * EADDRINUSE（前の worker がまだ終了処理中）なら onWaiting を1回呼び、期限まで再試行する
 */
export function acquireLease(pipePath: string, opts: { timeoutMs: number; onWaiting?: () => void }): Promise<LeaseResult> {
  const deadline = Date.now() + opts.timeoutMs;
  let waited = false;
  const tryOnce = (): Promise<LeaseResult> => new Promise((done) => {
    const server: Server = createServer((sock) => sock.destroy()); // 接続してきても何も読まず切る
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EADDRINUSE") return done({ ok: false, reason: "denied" });
      if (!waited) { waited = true; opts.onWaiting?.(); }
      if (Date.now() >= deadline) return done({ ok: false, reason: "timeout" });
      setTimeout(() => tryOnce().then(done), Math.min(RETRY_MS, Math.max(0, deadline - Date.now())));
    });
    server.listen(pipePath, () => {
      server.removeAllListeners("error");
      done({ ok: true, release: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
  return tryOnce();
}

/**
 * lease の名前。Windows の利用者 SID は子プロセス（whoami）なしでは取れないので、
 * ここでは username＋USERDOMAIN で代用する（同名の別ドメイン利用者は区別できるが SID そのものではない）
 */
export function leasePipePath(userRoot: string, sid = `${process.env.USERDOMAIN ?? ""}\\${userInfo().username}`): string {
  const win = process.platform === "win32";
  const root = win ? resolve(userRoot).toLowerCase() : resolve(userRoot);
  const hash = createHash("sha256").update(`${sid}\0${root}`).digest("hex").slice(0, 32);
  return win ? `\\\\.\\pipe\\dc-designer-lease-${hash}` : `/tmp/dc-designer-lease-${hash}.sock`;
}
