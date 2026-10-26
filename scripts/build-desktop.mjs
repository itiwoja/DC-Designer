// Windows 版の隔離ビルド：許可リストのものだけを .desktop-stage/app に作る。
// 使い方: node scripts/build-desktop.mjs
import { build as esbuild } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import { inspectTarget } from "./inspect-desktop.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, ".desktop-stage");
const app = path.join(stage, "app");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function fail(msg) {
  console.error(`desktop:build: ${msg}`);
  process.exit(1);
}

rmSync(path.join(root, "build"), { recursive: true, force: true });
rmSync(stage, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

// 入口が無ければ分かりやすく止める
for (const f of ["desktop/main.ts", "desktop/preload.ts", "server/desktop-worker.ts"]) {
  if (!existsSync(path.join(root, f))) fail(`入口がありません: ${f}`);
}

// Web（public/ は利用者画像が入り得るので使わない）
console.log("vite build");
await viteBuild({
  root,
  configFile: path.join(root, "vite.config.ts"),
  publicDir: false,
  logLevel: "warn",
  build: { outDir: path.join(app, "dist"), emptyOutDir: true },
});

// main / preload / worker
const common = {
  absWorkingDir: root,
  bundle: true,
  minify: false,
  sourcemap: false,
  logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' },
};
const out = path.join(app, "build", "desktop");
console.log("esbuild");
await esbuild({
  ...common,
  entryPoints: { main: "desktop/main.ts" },
  outdir: out,
  outExtension: { ".js": ".cjs" },
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});
await esbuild({
  ...common,
  entryPoints: { preload: "desktop/preload.ts" },
  outdir: out,
  outExtension: { ".js": ".cjs" },
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});
await esbuild({
  ...common,
  entryPoints: { worker: "server/desktop-worker.ts" },
  outdir: out,
  outExtension: { ".js": ".mjs" },
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});

// pdfjs の同梱資源
for (const d of ["cmaps", "standard_fonts", "wasm"]) {
  cpSync(path.join(root, "node_modules/pdfjs-dist", d), path.join(app, "build/pdf-assets", d), { recursive: true });
}

// 配布用 package.json は新しく書く（dependencies なし：全部束ねてある）
const appPkg = {
  name: "dc-designer",
  productName: "DC-Designer",
  version: pkg.version,
  description: pkg.description,
  license: "MIT",
  author: { name: "itiwoja" },
  main: "build/desktop/main.cjs",
};
writeFileSync(path.join(app, "package.json"), JSON.stringify(appPkg, null, 2) + "\n");
cpSync(path.join(root, "LICENSE"), path.join(app, "LICENSE"));

console.log("inspect stage");
if (!(await inspectTarget(app))) fail("ステージの検査に失敗しました");
console.log("desktop:build ok");
