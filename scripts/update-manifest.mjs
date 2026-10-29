// 自動更新の目録（latest.yml）を、公開するインストーラーから作る。
// 署名で exe の中身が変わるため、electron-builder が作ったものは使わない。
// 使い方: node scripts/update-manifest.mjs <installer.exe> <version> > latest.yml
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const [file, version] = process.argv.slice(2);
if (!file || !/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: node scripts/update-manifest.mjs <installer.exe> <x.y.z>");
  process.exit(2);
}
const name = path.basename(file);
const sha512 = createHash("sha512").update(readFileSync(file)).digest("base64");
const size = statSync(file).size;
process.stdout.write(
  [
    `version: ${version}`,
    "files:",
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n"),
);
