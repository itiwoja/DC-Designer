import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 製品版か（DC_DESIGNER_DESKTOP=1。desktop/runtime.ts が worker に渡す） */
export const isDesktopMode = () => process.env.DC_DESIGNER_DESKTOP === "1";

/** 作品・設定の保存先（DATA_DIR。開発版の既定はリポジトリ直下の data/） */
export const dataDir = () => process.env.DATA_DIR || fileURLToPath(new URL("../data/", import.meta.url));

/** 秘密情報の保存先（DC_DESIGNER_CONFIG_DIR） */
export const configDir = () => process.env.DC_DESIGNER_CONFIG_DIR || join(homedir(), ".config", "dc-designer");
