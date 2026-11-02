import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AssetRequest } from "../src/schema";

// 環境変数は server/imagegen.ts を読み込む前に設定する（GENERATED_DIR は読み込み時に固定される）
const root = mkdtempSync(join(tmpdir(), "imagegen-desktop-test-"));
process.env.GENERATED_DIR = join(root, "generated");
process.env.DC_DESIGNER_DESKTOP = "1";
delete process.env.IMAGE_PROVIDER;
delete process.env.COMFYUI_URL;
process.env.CODEX_KILL_GRACE_MS = "30";

type Imagegen = typeof import("../server/imagegen");
type Settings = typeof import("../server/image-settings");
let imagegen: Imagegen;
let settings: Settings;
let server: import("node:http").Server;
let base = "";

beforeAll(async () => {
  imagegen = await import("../server/imagegen");
  settings = await import("../server/image-settings");
  const { registerImageRoutes } = await import("../server/routes/images");
  const { createRouteHandlers } = await import("../server/route-handlers");
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  registerImageRoutes(app, createRouteHandlers({ desktop: true }));
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
let dataDir = "";
let userHome = ""; // 利用者の CODEX_HOME（~/.codex の代わり）
let userRoot = "";
let binDir = "";
beforeEach(() => {
  const dir = join(root, `case${++n}`);
  dataDir = join(dir, "workspace");
  userHome = join(dir, "user-codex");
  userRoot = join(dir, "userroot");
  binDir = join(dir, "bin");
  for (const d of [dataDir, userHome, userRoot, binDir]) mkdirSync(d, { recursive: true });
  process.env.DATA_DIR = dataDir;
  process.env.CODEX_HOME = userHome;
  process.env.DC_DESIGNER_USER_ROOT = userRoot;
  // 開発機に入っている本物の codex を見つけない（起動しない）よう、PATH は偽の codex の置き場と最小限だけにする
  process.env.PATH = `${binDir}:/usr/bin:/bin`;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
});
const ORIGINAL_PATH = process.env.PATH ?? "";
afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
});

const put = (body: unknown) =>
  fetch(`${base}/api/image/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---- 偽の codex（小さな node スクリプト）----
const PNG = Buffer.from("89504e470d0a1a0a-real", "utf8");

/** 偽の codex を bin に置く。opts: tid（thread_id）、rewriteAuth（auth.json を書き換える）、fail（exit 1） */
function installFakeCodex(opts: { tid?: string | null; rewriteAuth?: string; fail?: boolean } = {}): { path: string; record: () => any } {
  const path = join(binDir, "codex");
  const recordFile = join(binDir, "record.json");
  const tid = opts.tid === undefined ? "thread-123" : opts.tid;
  writeFileSync(path, `#!${process.execPath}
const fs = require("fs"), p = require("path");
const home = process.env.CODEX_HOME;
fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), home,
  authExists: fs.existsSync(p.join(home, "auth.json")),
  envKeys: Object.keys(process.env),
  homeEntries: fs.readdirSync(home),
}));
${tid ? `console.log(JSON.stringify({ type: "thread.started", thread_id: ${JSON.stringify(tid)} }));` : ""}
const gen = p.join(home, "generated_images");
fs.mkdirSync(p.join(gen, "other-thread"), { recursive: true });
fs.writeFileSync(p.join(gen, "other-thread", "decoy.png"), "DECOY");
${tid ? `fs.mkdirSync(p.join(gen, ${JSON.stringify(tid)}), { recursive: true });
fs.writeFileSync(p.join(gen, ${JSON.stringify(tid)}, "out.png"), ${JSON.stringify(PNG.toString())});` : ""}
${opts.rewriteAuth ? `fs.writeFileSync(p.join(home, "auth.json"), ${JSON.stringify(opts.rewriteAuth)});` : ""}
${opts.fail ? 'console.error("boom"); process.exit(1);' : ""}
`);
  chmodSync(path, 0o755);
  return { path, record: () => JSON.parse(readFileSync(recordFile, "utf8")) };
}

const asset = (prompt: string) => ({ prompt, transparent: false, aspect: "square" } as AssetRequest);

describe("製品版の availableProviders", () => {
  it("キーも Codex も無ければ comfyui と placeholder だけ（openai は出さない）", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(imagegen.availableProviders()).toEqual(["comfyui", "placeholder"]);
  });

  it("Gemini キーがあれば gemini が先頭に出る", () => {
    process.env.GEMINI_API_KEY = "g-test";
    expect(imagegen.availableProviders()).toEqual(["gemini", "comfyui", "placeholder"]);
  });

  it("Codex は見つかりサインイン済みのときだけ出る", () => {
    // 見つからない
    settings.updateImageSettings({ codexPath: join(binDir, "codex") });
    expect(imagegen.codexStatus()).toMatchObject({ state: "not_found", installVersion: "0.166.0" });
    expect(imagegen.codexStatus().path).toBeUndefined();
    expect(imagegen.availableProviders()).not.toContain("codex");
    // 見つかるがサインインしていない
    const { path } = installFakeCodex();
    expect(imagegen.codexStatus()).toMatchObject({ state: "signed_out", path, source: "configured" });
    expect(imagegen.availableProviders()).not.toContain("codex");
    // ready
    writeFileSync(join(userHome, "auth.json"), "{}");
    expect(imagegen.codexStatus()).toMatchObject({ state: "ready", path, source: "configured" });
    expect(imagegen.availableProviders()).toEqual(["comfyui", "codex", "placeholder"]);
  });

  it("設定のパスが無くても PATH 上の codex を自動検出する", () => {
    const { path } = installFakeCodex();
    writeFileSync(join(userHome, "auth.json"), "{}");
    expect(imagegen.codexStatus()).toMatchObject({ state: "ready", path, source: "path" });
  });

  it("PATH に無ければ、このアプリが入れた codex（<userRoot>/tools/codex/<版>/）を自動検出する", () => {
    const { path: fake } = installFakeCodex();
    const own = settings.appCodexExe()!;
    expect(own).toBe(join(userRoot, "tools", "codex", "0.166.0", "codex"));
    mkdirSync(join(own, ".."), { recursive: true });
    writeFileSync(own, readFileSync(fake));
    chmodSync(own, 0o755);
    rmSync(fake);
    expect(imagegen.codexStatus()).toMatchObject({ state: "signed_out", path: own, source: "app" });
  });
});

describe("PUT /api/image/settings", () => {
  it("正しい値は保存され、image-settings.json に入る", async () => {
    const { path } = installFakeCodex();
    const res = await put({ comfyuiUrl: "http://localhost:9000/", codexPath: path });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ comfyuiUrl: "http://localhost:9000", codexPath: path });
    expect(JSON.parse(readFileSync(join(dataDir, "image-settings.json"), "utf8"))).toEqual({ comfyuiUrl: "http://localhost:9000", codexPath: path });
    expect(settings.comfyBaseUrl()).toBe("http://localhost:9000/");
    // 空文字で既定に戻る
    expect(await (await put({ comfyuiUrl: "" })).json()).toEqual({ comfyuiUrl: "", codexPath: path });
    expect(settings.comfyBaseUrl()).toBe("http://127.0.0.1:8188/");
  });

  it.each([
    "http://example.com:8188",
    "http://192.168.0.5:8188",
    "http://127.0.0.1.evil.com",
    "ftp://127.0.0.1",
    "http://user:pw@127.0.0.1:8188",
    "http://127.0.0.1:8188/sub",
    "http://127.0.0.1:8188/?a=1",
    "127.0.0.1:8188",
  ])("ループバック以外・path 付きなどの comfyuiUrl は 400: %s", async (url) => {
    const res = await put({ comfyuiUrl: url });
    expect(res.status).toBe(400);
    expect(existsSync(join(dataDir, "image-settings.json"))).toBe(false);
  });

  it("[::1] と https のループバックは通る", async () => {
    expect((await put({ comfyuiUrl: "http://[::1]:8188" })).status).toBe(200);
    expect((await put({ comfyuiUrl: "https://127.0.0.1:8443" })).status).toBe(200);
  });

  it.each(["codex", "./codex", "/usr/bin/node", "/usr/bin/codex.exe", "/usr/bin/codex2", "/usr/bin/"])("相対パス・別名の codexPath は 400: %s", async (p) => {
    expect((await put({ codexPath: p })).status).toBe(400);
  });

  it("文字列以外は 400", async () => {
    expect((await put({ comfyuiUrl: 1 })).status).toBe(400);
    expect((await put({ codexPath: ["/x/codex"] })).status).toBe(400);
  });
});

describe("製品版の Codex 実行", () => {
  const prepare = (authText = '{"tokens":"orig"}') => {
    const fake = installFakeCodex({ rewriteAuth: undefined });
    settings.updateImageSettings({ codexPath: fake.path });
    writeFileSync(join(userHome, "auth.json"), authText);
    return fake;
  };

  it("専用 CODEX_HOME で実行し、thread_id のフォルダの png だけを採用して片付ける", async () => {
    process.env.SECRET_TEST_VALUE = "must-not-leak";
    const fake = prepare();
    const r = await imagegen.generateAsset(asset("desktop-codex-1"), {}, "codex");
    expect(r.provider).toBe("codex");
    expect(readFileSync(join(process.env.GENERATED_DIR!, r.src.replace("/generated/", "")))).toEqual(PNG);

    const rec = fake.record();
    const appHome = join(userRoot, "cache", "codex-home");
    expect(rec.home).toBe(appHome);
    expect(rec.home).not.toBe(userHome);
    expect(rec.authExists).toBe(true);
    expect(rec.homeEntries).toContain("auth.json");
    expect(rec.cwd).not.toBe(process.cwd());
    expect(rec.args).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--json", "--sandbox", "read-only"]));
    expect(rec.envKeys).not.toContain("SECRET_TEST_VALUE");
    expect(rec.envKeys).toContain("CODEX_HOME");
    // 片付け：専用側の auth.json と生成物は残らない。利用者の auth.json は元のまま
    expect(readdirSync(appHome)).toEqual([]);
    expect(readFileSync(join(userHome, "auth.json"), "utf8")).toBe('{"tokens":"orig"}');
    expect(readdirSync(userHome)).toEqual(["auth.json"]);
    delete process.env.SECRET_TEST_VALUE;
  });

  it("auth.json が書き換わったら利用者の auth.json へ書き戻す", async () => {
    const fake = installFakeCodex({ rewriteAuth: '{"tokens":"refreshed"}' });
    settings.updateImageSettings({ codexPath: fake.path });
    writeFileSync(join(userHome, "auth.json"), '{"tokens":"orig"}');
    await imagegen.generateAsset(asset("desktop-codex-2"), {}, "codex");
    expect(readFileSync(join(userHome, "auth.json"), "utf8")).toBe('{"tokens":"refreshed"}');
    expect(readdirSync(userHome).sort()).toEqual(["auth.json"]); // tmp が残らない
    expect(readdirSync(join(userRoot, "cache", "codex-home"))).toEqual([]);
  });

  it("失敗しても書き戻しと片付けをする", async () => {
    const fake = installFakeCodex({ rewriteAuth: '{"tokens":"refreshed"}', fail: true });
    settings.updateImageSettings({ codexPath: fake.path });
    writeFileSync(join(userHome, "auth.json"), '{"tokens":"orig"}');
    await expect(imagegen.generateAsset(asset("desktop-codex-3"), {}, "codex")).rejects.toMatchObject({ code: "exit" });
    expect(readFileSync(join(userHome, "auth.json"), "utf8")).toBe('{"tokens":"refreshed"}');
    expect(readdirSync(join(userRoot, "cache", "codex-home"))).toEqual([]);
  });

  it("thread_id が分からなければ、他の png があっても採用しない", async () => {
    const fake = installFakeCodex({ tid: null });
    settings.updateImageSettings({ codexPath: fake.path });
    writeFileSync(join(userHome, "auth.json"), "{}");
    await expect(imagegen.generateAsset(asset("desktop-codex-4"), {}, "codex")).rejects.toMatchObject({ code: "no_image" });
    expect(readdirSync(join(userRoot, "cache", "codex-home"))).toEqual([]);
  });

  it("サインインしていなければ codex は選べず placeholder に落ち、起動もしない", async () => {
    const fake = installFakeCodex();
    settings.updateImageSettings({ codexPath: fake.path });
    // ready でないので provider は placeholder に落ちる
    const r = await imagegen.generateAsset(asset("desktop-codex-5"), {}, "codex");
    expect(r.provider).toBe("placeholder");
    expect(existsSync(join(binDir, "record.json"))).toBe(false);
  });
});

/** NDJSON の応答を行ごとの JSON にする */
const postNdjson = async (path: string) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
};

describe("製品版の画像生成の失敗の伝え方", () => {
  it("Codex の失敗は、stderr（パスを含みうる）を出さず、直し方の分かる決まった文言と code を返す", async () => {
    const fake = installFakeCodex({ fail: true });
    settings.updateImageSettings({ codexPath: fake.path });
    writeFileSync(join(userHome, "auth.json"), "{}");
    const res = await fetch(`${base}/api/asset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asset: asset("desktop-codex-err"), provider: "codex" }) });
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.code).toBe("exit");
    expect(body.error).toContain("Codex CLI が途中で失敗しました");
    expect(body.error).not.toContain("boom");
    expect(body.error).not.toContain(binDir);
  });

  it("ComfyUI に接続できなければ、内部エラーではなく起動の確認を案内する", async () => {
    settings.updateImageSettings({ comfyuiUrl: "http://127.0.0.1:9" });
    const res = await fetch(`${base}/api/asset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asset: asset("desktop-comfy-err"), provider: "comfyui" }) });
    const body = await res.json();
    expect(body.code).toBe("comfyui_unreachable");
    expect(body.error).toContain("http://127.0.0.1:9/ で ComfyUI が起動しているか");
  });
});

describe("POST /api/codex/login・/api/codex/install", () => {
  /** `codex login` のまね：認可 URL を出し、成功なら CODEX_HOME に auth.json を作る */
  function installFakeLogin(ok: boolean) {
    const path = join(binDir, "codex");
    writeFileSync(path, `#!${process.execPath}
const fs = require("fs"), p = require("path");
fs.writeFileSync(${JSON.stringify(join(binDir, "login-args.json"))}, JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME || null }));
console.error("Starting local login server on http://localhost:1455.\\nIf your browser did not open, navigate to this URL to authenticate:\\n\\nhttps://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&state=abc\\n");
${ok ? 'fs.writeFileSync(p.join(process.env.CODEX_HOME, "auth.json"), "{}"); console.log("Successfully logged in");' : `console.error("login failed at ${binDir}"); process.exit(1);`}
`);
    chmodSync(path, 0o755);
    return path;
  }

  it("codex login を利用者の CODEX_HOME で実行し、認可 URL を進み具合で流し、auth.json ができたら済む", async () => {
    installFakeLogin(true);
    const lines = await postNdjson("/api/codex/login");
    expect(lines[0]).toEqual({ progress: { phase: "setup", step: "login" } });
    expect(lines.some((l) => l.progress?.url?.startsWith("https://auth.openai.com/oauth/authorize?"))).toBe(true);
    expect(lines.at(-1)).toEqual({ result: { signedIn: true } });
    expect(JSON.parse(readFileSync(join(binDir, "login-args.json"), "utf8"))).toEqual({ args: ["login"], home: userHome });
    expect(existsSync(join(userHome, "auth.json"))).toBe(true);
    expect(imagegen.codexStatus().state).toBe("ready");
  });

  it("codex login が失敗したら、出力（パスを含みうる）を出さずに決まった文言を返す", async () => {
    installFakeLogin(false);
    const last = (await postNdjson("/api/codex/login")).at(-1);
    expect(last.code).toBe("codex_login_failed");
    expect(last.error).toBe("Codex にサインインできませんでした。もう一度試してください");
  });

  it("Codex が無ければサインインは not_found", async () => {
    const last = (await postNdjson("/api/codex/login")).at(-1);
    expect(last).toMatchObject({ code: "not_found", status: 400 });
  });

  it("Windows 以外ではアプリから入れられない（codex_install_unsupported）", async () => {
    const last = (await postNdjson("/api/codex/install")).at(-1);
    expect(last).toMatchObject({ code: "codex_install_unsupported", status: 400 });
  });
});

describe("findNewestFile（Codex アプリ同梱の CLI を選ぶ）", () => {
  it("古い版のフォルダが残っていても、更新日時の新しい codex.exe を選ぶ", () => {
    const bin = join(root, "codex-app-bin");
    const put = (dir: string, file: string, t: number) => {
      mkdirSync(join(bin, dir), { recursive: true });
      writeFileSync(join(bin, dir, file), "x");
      utimesSync(join(bin, dir, file), t, t);
    };
    // 名前の順（readdir で先に来やすい）と更新日時の順を逆にしておく
    put("aaaa-old", "codex.exe", 1_700_000_000);
    put("zzzz-new", "codex.exe", 1_800_000_000);
    put("mmmm-rg", "rg.exe", 1_900_000_000);
    expect(imagegen.findNewestFile(bin, "codex.exe", 3)).toBe(join(bin, "zzzz-new", "codex.exe"));
  });

  it("見つからなければ undefined", () => {
    expect(imagegen.findNewestFile(join(root, "no-such-dir"), "codex.exe", 3)).toBeUndefined();
  });
});
