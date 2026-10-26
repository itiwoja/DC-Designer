import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error .mjs のスクリプトを直接読む
import { checkPath, dirEntries, inspectEntries, scanContent } from "../scripts/inspect-desktop.mjs";

type Problem = { file: string; kind: string };
const dirs: string[] = [];
afterEach(() => {
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
