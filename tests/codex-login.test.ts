import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SetupProgress } from "../server/codex-setup";

const root = mkdtempSync(join(tmpdir(), "codex-login-test-"));
process.env.GENERATED_DIR = join(root, "generated");
process.env.DC_DESIGNER_DESKTOP = "1";
process.env.DATA_DIR = join(root, "workspace");
process.env.CODEX_HOME = join(root, "user-codex");
process.env.DC_DESIGNER_USER_ROOT = join(root, "userroot");
const binDir = join(root, "bin");
// 開発機に入っている本物の codex を起動しないよう、PATH は偽の codex の置き場と最小限だけにする
process.env.PATH = `${binDir}:/usr/bin:/bin`;
for (const d of [process.env.DATA_DIR, process.env.CODEX_HOME, binDir]) mkdirSync(d, { recursive: true });

let setup: typeof import("../server/codex-setup");
beforeAll(async () => { setup = await import("../server/codex-setup"); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("サインインを待つあいだ、認可 URL つきの進み具合を一定間隔で送り直す（main の読み取りが途切れて切れないように）", async () => {
  const path = join(binDir, "codex");
  writeFileSync(path, `#!${process.execPath}
console.error("https://auth.openai.com/oauth/authorize?client_id=x&state=y");
setTimeout(() => { require("fs").writeFileSync(require("path").join(process.env.CODEX_HOME, "auth.json"), "{}"); }, 250);
`);
  chmodSync(path, 0o755);
  const got: SetupProgress[] = [];
  const r = await setup.loginCodex((p) => got.push(p), new AbortController().signal, { heartbeatMs: 40 });
  expect(r).toEqual({ signedIn: true });
  const withUrl = got.filter((p) => p.url === "https://auth.openai.com/oauth/authorize?client_id=x&state=y");
  expect(withUrl.length).toBeGreaterThan(1);
  expect(got.every((p) => p.phase === "setup" && p.step === "login")).toBe(true);
});
