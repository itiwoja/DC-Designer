// npm run dev 用: API サーバーが接続を受け付けるまで待ってから終了する。
// Vite を先に立ち上げると、開いているタブの /api や /generated へのリクエストが
// API の起動前に届いて ECONNREFUSED（http proxy error）になるため、Vite の起動をここで待たせる
import "dotenv/config";
import { connect } from "node:net";

const port = Number(process.env.API_PORT || 8787);
const TIMEOUT_MS = 60_000;
const started = Date.now();

const tryConnect = () => new Promise((resolve) => {
  const sock = connect({ host: "127.0.0.1", port });
  sock.once("connect", () => { sock.destroy(); resolve(true); });
  sock.once("error", () => { sock.destroy(); resolve(false); });
});

while (!(await tryConnect())) {
  if (Date.now() - started > TIMEOUT_MS) {
    console.warn(`[wait] API (127.0.0.1:${port}) が ${TIMEOUT_MS / 1000} 秒以内に起動しなかったため、待たずに Vite を起動します`);
    break;
  }
  await new Promise((r) => setTimeout(r, 300));
}
