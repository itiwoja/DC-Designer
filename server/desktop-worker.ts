/**
 * 製品版の API worker（Electron の utilityProcess で動く）。
 * 手順: init を待つ → userRoot の lease を取る → app を組み立てて 127.0.0.1:0 で listen → ready。
 * library 等は import 時に環境変数を読むだけで書き込みは始めないが、念のため lease を取ってから動的 import する
 */
import { createServer, type Server } from "node:http";
import { API_PROTOCOL_VERSION, LEASE_TIMEOUT_MS, type MainToWorker, type WorkerToMain } from "../desktop/protocol";
import { acquireLease, leasePipePath } from "./lease";

// Electron の型が無くても通るよう、使う分だけ宣言する
type ParentPort = {
  on(event: "message", cb: (e: { data: unknown }) => void): void;
  postMessage(msg: WorkerToMain): void;
};
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

const send = (msg: WorkerToMain) => parentPort?.postMessage(msg);
const die = (code: number, msg?: WorkerToMain): never => {
  if (msg) send(msg);
  // メッセージが届くのを待ってから終了する
  setTimeout(() => process.exit(code), 50);
  return undefined as never;
};

function parseInit(data: unknown): Extract<MainToWorker, { type: "init" }> | null {
  const d = data as Record<string, unknown> | null;
  if (!d || d.type !== "init") return null;
  const { token, instanceId, appVersion } = d;
  if (typeof token !== "string" || !/^[0-9a-fA-F]{64,}$/.test(token)) return null;
  if (typeof instanceId !== "string" || !instanceId || typeof appVersion !== "string" || !appVersion) return null;
  return { type: "init", token, instanceId, appVersion };
}

async function start(init: Extract<MainToWorker, { type: "init" }>) {
  const userRoot = process.env.DC_DESIGNER_USER_ROOT;
  if (!userRoot) return die(1, { type: "fatal", code: "INIT_INVALID" });

  const lease = await acquireLease(leasePipePath(userRoot), { timeoutMs: LEASE_TIMEOUT_MS, onWaiting: () => send({ type: "lease-waiting" }) });
  if (!lease.ok) return die(1, { type: "lease-failed", reason: lease.reason });

  let server: Server;
  try {
    const { createApp } = await import("./app");
    let port = 0;
    const handle = createApp({ mode: "desktop", token: init.token, instanceId: init.instanceId, appVersion: init.appVersion, getPort: () => port });
    server = createServer(handle.app);
    await new Promise<void>((ok, ng) => { server.once("error", ng); server.listen(0, "127.0.0.1", ok); });
    port = (server.address() as { port: number }).port;

    parentPort!.on("message", ({ data }) => {
      const m = data as MainToWorker;
      if (m.type === "drain") void handle.drain().then(() => send({ type: "drained", requestId: m.requestId, busy: false }));
      else if (m.type === "resume") { handle.resume(); send({ type: "resumed", requestId: m.requestId }); }
      else if (m.type === "shutdown") {
        server.close(async () => { await lease.release(); process.exit(0); });
        server.closeAllConnections();
      }
    });
    send({ type: "ready", port, instanceId: init.instanceId, apiProtocolVersion: API_PROTOCOL_VERSION, appVersion: init.appVersion });
  } catch {
    await lease.release();
    die(1, { type: "fatal", code: "LISTEN_FAILED" });
  }
}

if (!parentPort) {
  process.exit(1); // 直接 node で起動された
} else {
  let started = false;
  parentPort.on("message", ({ data }) => {
    if (started) return;
    started = true;
    const init = parseInit(data);
    if (!init) return die(1, { type: "fatal", code: "INIT_INVALID" });
    start(init).catch(() => die(1, { type: "fatal", code: "INTERNAL" }));
  });
}
