import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppHandler } from "../desktop/appHandler";
import { buildCsp, inlineScriptHashes } from "../desktop/appProtocol";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dc-handler-"));
  await writeFile(path.join(dir, "index.html"), "");
  await writeFile(path.join(dir, "test.png"), "");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const handler = (fetchFile: Parameters<typeof createAppHandler>[1]) => createAppHandler({ dist: dir, pdfAssets: dir, generated: dir }, fetchFile);

describe("app:// の配信", () => {
  it("HTML の CSP に inline script のハッシュを付け、HEAD に本文を返さない", async () => {
    const html = '<html><script>document.title = "DC";</script></html>';
    const fetchFile = vi.fn(async () => new Response(html));
    const handle = handler(fetchFile);
    for (const method of ["GET", "HEAD"]) {
      const res = await handle(new Request("app://dc-designer/", { method }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe(buildCsp(inlineScriptHashes(html)));
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe(method === "GET" ? html : "");
    }
    expect(fetchFile.mock.calls[0]).toEqual([expect.stringContaining("index.html"), { bypassCustomProtocolHandlers: true }]);
  });

  it("Range を中継し、HEAD ではストリームを解放する", async () => {
    const cancel = vi.fn();
    const fetchFile = vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      status: 206, headers: { "content-range": "bytes 0-1/10", "content-length": "2", "accept-ranges": "bytes" },
    }));
    const res = await handler(fetchFile)(new Request("app://dc-designer/generated/test.png", { method: "HEAD", headers: { range: "bytes=0-1" } }));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-1/10");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(fetchFile).toHaveBeenCalledWith(expect.any(String), { bypassCustomProtocolHandlers: true, headers: { range: "bytes=0-1" } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(await res.text()).toBe("");
  });

  it("許可外の URL・存在しないファイル・ディレクトリを読み込まない", async () => {
    await mkdir(path.join(dir, "directory.png"));
    const fetchFile = vi.fn();
    const handle = handler(fetchFile);
    for (const url of ["app://other/index.html", "app://dc-designer/api/status", "app://dc-designer/missing.png", "app://dc-designer/directory.png"]) {
      expect((await handle(new Request(url))).status).toBe(404);
    }
    expect((await handle(new Request("app://dc-designer/", { method: "POST" }))).status).toBe(405);
    expect(fetchFile).not.toHaveBeenCalled();
  });
});
