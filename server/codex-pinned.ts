/**
 * 設定画面の「Codex CLI を入れる」で入れる Codex CLI の固定版（2026-11-01、ユーザーの決定：版を固定し、ハッシュが一致したものだけ入れる）。
 * 公式の GitHub リリース（openai/codex）の Windows 向け tar.gz。sha256 はリリースの digest を写したもの。
 * 版を上げるときは version・tag と、各ファイルの name・size・sha256 をまとめて書き換え、実機で画像生成まで確かめる
 */
export type PinnedCodexAsset = {
  /** リリースのファイル名（tar.gz。中身は codex-<arch>-pc-windows-msvc.exe が 1 つ） */
  name: string;
  /** tar.gz の大きさ（バイト） */
  size: number;
  /** tar.gz の sha256（16進・小文字） */
  sha256: string;
  /** tar の中の実行ファイル名 */
  entry: string;
};

export const PINNED_CODEX = {
  version: "0.166.0",
  tag: "rust-v0.166.0",
  assets: {
    x64: {
      name: "codex-x86_64-pc-windows-msvc.exe.tar.gz",
      size: 124_156_226,
      sha256: "dafeb48b5a853b2898453a6b5bdae0fa0646bd5d5b73c5dfe74c97d0af4a4a0d",
      entry: "codex-x86_64-pc-windows-msvc.exe",
    },
    arm64: {
      name: "codex-aarch64-pc-windows-msvc.exe.tar.gz",
      size: 113_835_364,
      sha256: "23cfbde45609292c325029a376340df30191298d7b6c5b26f607f481573ac768",
      entry: "codex-aarch64-pc-windows-msvc.exe",
    },
  } satisfies Record<string, PinnedCodexAsset>,
} as const;

/** ダウンロード元（github.com のリリース。実体は release-assets.githubusercontent.com へ転送される） */
export const CODEX_RELEASE_HOST = "github.com";
export const codexReleasePath = (asset: PinnedCodexAsset) => `/openai/codex/releases/download/${PINNED_CODEX.tag}/${asset.name}`;
/** github.com が転送してくる先として受け付けるホスト */
export const CODEX_ASSET_HOSTS = ["release-assets.githubusercontent.com", "objects.githubusercontent.com"] as const;

/** この PC に入れられるファイル。Windows の x64 / arm64 以外は undefined（入れられない） */
export function pinnedCodexAsset(platform: string = process.platform, arch: string = process.arch): PinnedCodexAsset | undefined {
  if (platform !== "win32") return undefined;
  if (arch === "x64") return PINNED_CODEX.assets.x64;
  if (arch === "arm64") return PINNED_CODEX.assets.arm64;
  return undefined;
}
