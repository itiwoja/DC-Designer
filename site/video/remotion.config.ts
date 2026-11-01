import { Config } from "@remotion/cli/config";
import { readdirSync } from "node:fs";

// WSL の Playwright の headless shell を使う（版は ~/.cache/ms-playwright の最新）
const pw = `${process.env.HOME}/.cache/ms-playwright`;
const shell = readdirSync(pw).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
Config.setEntryPoint("./src/index.ts");
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(92);
Config.setConcurrency(2);
if (shell) Config.setBrowserExecutable(`${pw}/${shell}/chrome-headless-shell-linux64/chrome-headless-shell`);
