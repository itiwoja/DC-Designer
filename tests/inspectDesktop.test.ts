import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
// @ts-expect-error .mjs のスクリプトを直接読む
import { asarEntries, checkPath, dirEntries, inspectEntries, inspectTarget, scanContent } from "../scripts/inspect-desktop.mjs";

const asar = createRequire(import.meta.url)("@electron/asar");

type Problem = { file: string; kind: string };
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeStage(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "inspect-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const clean = {
  "package.json": "{}",
  LICENSE: "MIT",
  "dist/index.html": "<html></html>",
  "dist/assets/index-abc.js": "console.log(1)",
  "build/desktop/main.cjs": "x",
  "build/desktop/preload.cjs": "x",
  "build/desktop/worker.mjs": "x",
  "build/pdf-assets/cmaps/a.bcmap": "x",
};

const run = (files: Record<string, string>): Problem[] => inspectEntries(dirEntries(makeStage(files))).problems;

function createLink(context: TestContext, destination: string, link: string, type: "file" | "dir" | "junction" = "file") {
  try {
    symlinkSync(destination, link, type);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code ?? "")) {
      context.skip(`リンク作成非対応または権限不足 (${code}, ${type})`);
      return false;
    }
    throw error;
  }
  return true;
}

async function makeArchive(unpack = false) {
  const source = makeStage(clean);
  const root = makeStage({});
  const target = path.join(root, "win-unpacked");
  const resources = path.join(target, "resources");
  mkdirSync(resources, { recursive: true });
  const archive = path.join(resources, "app.asar");
  await asar.createPackageWithOptions(source, archive, unpack ? { unpack: "**/worker.mjs" } : {});
  return { target, resources, archive };
}

describe("実 ASAR の検査", () => {
  it("ディレクトリは除外し、正常な packed/unpacked ファイルは検査する", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, archive } = await makeArchive(true);
    const result = inspectEntries(await asarEntries(archive));
    expect(result.problems).toEqual([]);
    expect(result.files.map((file: { path: string }) => file.path).sort()).toEqual(Object.keys(clean).sort());
    expect(await inspectTarget(target)).toBe(true);
  });

  it("unpacked ファイルが欠落していると抽出失敗を握り潰さない", async () => {
    const { target, archive } = await makeArchive(true);
    rmSync(path.join(`${archive}.unpacked`, "build/desktop/worker.mjs"));
    await expect(inspectTarget(target)).rejects.toThrow("ASAR entry could not be inspected");
  });

  it.each(["extra.txt", "extra-dir"])("resources の追加物 %s を拒否する", async (name) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { target, resources } = await makeArchive();
    if (name === "extra-dir") mkdirSync(path.join(resources, name));
    else writeFileSync(path.join(resources, name), "extra");
    expect(await inspectTarget(target)).toBe(false);
    expect(error).toHaveBeenCalledWith(`  NG resources/${name}: not in allowlist`);
  });

  it("ASAR 内のリンクを追跡せず拒否する", async () => {
    // ASAR の Pickle ヘッダーを直接構成し、OS のリンク作成権限に依存しない。
    const archive = path.join(makeStage({}), "link.asar");
    const json = Buffer.from(JSON.stringify({ files: { "link.js": { link: "missing.js" } } }));
    const header = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4);
    header.writeUInt32LE(header.length - 4, 0);
    header.writeUInt32LE(json.length, 4);
    json.copy(header, 8);
    const size = Buffer.alloc(8);
    size.writeUInt32LE(4, 0);
    size.writeUInt32LE(header.length, 4);
    writeFileSync(archive, Buffer.concat([size, header]));
    expect(asar.statFile(archive, "link.js", false)).toEqual({ link: "missing.js" });
    await expect(asarEntries(archive)).rejects.toThrow("ASAR entry could not be inspected");
  });

  it("resources 直下の dangling symlink も拒否する", async (context) => {
    const { target, resources } = await makeArchive();
    if (!createLink(context, "missing", path.join(resources, "extra"))) return;
    await expect(inspectTarget(target)).rejects.toThrow("symbolic links are not allowed");
  });

  it("ステージ内の symlink も拒否する", (context) => {
    const stage = makeStage(clean);
    if (!createLink(context, "index-abc.js", path.join(stage, "dist/assets/link.js"))) return;
    expect(() => dirEntries(stage)).toThrow("symbolic links are not allowed");
  });

  for (const type of ["dir", "junction"] as const) {
    it(`packed target ルートの ${type} リンクを拒否する`, async (context) => {
      const { target } = await makeArchive();
      const link = path.join(makeStage({}), "target-link");
      // junction は Windows では通常 symlink 特権なしでも作成可能。
      if (!createLink(context, target, link, type)) return;
      const extract = vi.spyOn(asar, "extractFile");
      await expect(inspectTarget(link)).rejects.toThrow("symbolic links are not allowed");
      expect(extract).not.toHaveBeenCalled();
    });
  }

  it("unpacked のリンクは ASAR ファイル抽出より先に拒否する", async (context) => {
    const { target, archive } = await makeArchive(true);
    const worker = path.join(`${archive}.unpacked`, "build/desktop/worker.mjs");
    rmSync(worker);
    if (!createLink(context, path.join(makeStage({ "worker.mjs": "x" }), "worker.mjs"), worker)) return;
    const extract = vi.spyOn(asar, "extractFile");
    await expect(inspectTarget(target)).rejects.toThrow("symbolic links are not allowed");
    expect(extract).not.toHaveBeenCalled();
  });
});

describe("checkPath", () => {
  it("許可リストの path は通す", () => {
    for (const rel of Object.keys(clean)) expect(checkPath(rel)).toBeNull();
  });
  it("禁止物と未知のファイルを弾く", () => {
    for (const rel of [
      ".env",
      "dist/.env.local",
      "data/a.json",
      "dist/generated/a.png",
      "dist/assets/a.js.map",
      "node_modules/x/index.js",
      "backup/a",
      ".claude/x",
      "tests/a.test.ts",
      "unknown.txt",
      "dist/assets/a.exe",
    ]) {
      expect(checkPath(rel), rel).not.toBeNull();
    }
  });
});

describe("scanContent", () => {
  it("秘密値の種類だけを返す", () => {
    const r = scanContent("a.js", Buffer.from("k='sk-abcdefghijklmnopqrstuvwxyz'; OPENAI_API_KEY=abcd1234efgh"));
    expect(r.map((x: Problem) => x.kind)).toEqual(expect.arrayContaining(["sk- key", "env assignment"]));
    expect(JSON.stringify(r)).not.toContain("abcdefghijklmnop");
  });
  it("開発者の絶対 path を検出する", () => {
    for (const s of ["/home/me/x", "/mnt/c/Users/me", "C:\\Users\\me\\a", "C:\\\\Users\\\\me"]) {
      expect(scanContent("a.js", Buffer.from(s)).length, s).toBeGreaterThan(0);
    }
  });
  it("普通の文字列は通す", () => {
    expect(scanContent("a.js", Buffer.from("const a = 'hello'; // sk-"))).toEqual([]);
  });
});

describe("inspectEntries", () => {
  it("正常なステージは問題なし", () => {
    expect(run(clean)).toEqual([]);
  });
  it("利用者画像・.env の混入を検出する", () => {
    const p = run({ ...clean, "dist/generated/user.png": "x", ".env": "A=1" });
    expect(p.map((x) => x.file)).toEqual(expect.arrayContaining(["dist/generated/user.png", ".env"]));
  });
  it("秘密値入りの js を検出する", () => {
    const p = run({ ...clean, "dist/assets/index-abc.js": "ghp_abcdefghijklmnop" });
    expect(p).toEqual([{ file: "dist/assets/index-abc.js", kind: "GitHub token" }]);
  });
});
