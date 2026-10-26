import "dotenv/config";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { createApp } from "./app";
import { aiProvider } from "./ai";
import { openRouterAvailable, openRouterModel } from "./openrouter";
import { availableProviders, imageProviderName } from "./imagegen";

// WSL は IPv6 が届かず IPv4 の接続も 250ms（Node の既定）を超えることがあり、全アドレスが ETIMEDOUT → "Connection error." になる
setDefaultAutoSelectFamilyAttemptTimeout(2000);

const port = Number(process.env.API_PORT || 8787);
const { app } = createApp({ mode: "dev", port });

// OAuth のコールバックは http://127.0.0.1:<port> 固定。既定の "::" だと WSL が Windows 側へ [::1] しか転送せず、
// ブラウザから 127.0.0.1 に届かないので IPv4 ループバックに明示的にバインドする
app.listen(port, "127.0.0.1", async () => {
  console.log(`[api] http://127.0.0.1:${port}  AI: ${(await aiProvider()) ?? "なし"}${openRouterAvailable() ? ` (OpenRouter: ${openRouterModel()})` : ""}  image provider: ${imageProviderName()} (available: ${availableProviders().join(", ")})`);
});
