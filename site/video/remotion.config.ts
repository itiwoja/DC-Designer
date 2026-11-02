import { Config } from "@remotion/cli/config";
import { existsSync, readdirSync } from "node:fs";

// WSL の Playwright の headless shell があれば使う（版は ~/.cache/ms-playwright の最新）。
// 無い PC・CI では指定せず、Remotion が自分で取ってくる Chrome Headless Shell を使う
const pw = `${process.env.HOME}/.cache/ms-playwright`;
const shell = existsSync(pw) ? readdirSync(pw).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop() : undefined;
const exe = shell && `${pw}/${shell}/chrome-headless-shell-linux64/chrome-headless-shell`;
Config.setEntryPoint("./src/index.ts");
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(92);
Config.setConcurrency(2);
if (exe && existsSync(exe)) Config.setBrowserExecutable(exe);
