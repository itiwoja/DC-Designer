import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildCsp, inlineScriptHashes, resolveAppTarget, targetFilePath } from "./appProtocol";

type AppRoots = Parameters<typeof targetFilePath>[1];
type FetchFile = (url: string, options: { bypassCustomProtocolHandlers: true; headers?: { range: string } }) => Promise<Response>;

const baseHeaders = (type: string, csp: string): Record<string, string> => ({
  "content-type": type,
  "content-security-policy": csp,
  "x-content-type-options": "nosniff",
});

/** app:// のファイル配信。許可する URL は appProtocol、読み取りは Electron の net.fetch に任せる。 */
export function createAppHandler(roots: AppRoots, fetchFile: FetchFile) {
  return async (request: Request): Promise<Response> => {
    const csp = buildCsp();
    const reply = (text: string, status: number) => new Response(request.method === "HEAD" ? null : text, {
      status, headers: baseHeaders("text/plain; charset=utf-8", csp),
    });
    if (request.method !== "GET" && request.method !== "HEAD") return reply("Method Not Allowed", 405);
    const target = resolveAppTarget(request.url);
    const file = target && targetFilePath(target, roots);
    if (!target || !file) return reply("Not Found", 404);
    try {
      if (!(await stat(file)).isFile()) return reply("Not Found", 404);
    } catch {
      return reply("Not Found", 404);
    }
    const fileUrl = pathToFileURL(file).toString();
    // テーマ決定用の inline script だけを CSP に追加する。
    if (target.kind === "dist" && target.segments.length === 1 && target.segments[0] === "index.html") {
      const res = await fetchFile(fileUrl, { bypassCustomProtocolHandlers: true });
      const html = await res.text();
      return new Response(request.method === "HEAD" ? null : html, {
        status: 200, headers: baseHeaders(target.type, buildCsp(inlineScriptHashes(html))),
      });
    }
    const range = request.headers.get("range");
    const res = await fetchFile(fileUrl, { bypassCustomProtocolHandlers: true, ...(range ? { headers: { range } } : {}) });
    const headers = baseHeaders(target.type, csp);
    for (const key of ["content-length", "content-range", "accept-ranges"]) {
      const value = res.headers.get(key);
      if (value) headers[key] = value;
    }
    if (request.method === "HEAD") await res.body?.cancel();
    return new Response(request.method === "HEAD" ? null : res.body, { status: res.status, headers });
  };
}
