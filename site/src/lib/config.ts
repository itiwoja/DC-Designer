// SITE-TBL-006：サイト設定
export const SITE_CONFIG = {
  site: "https://itiwoja.github.io",
  base: "/DC-Designer",
  repo: "itiwoja/DC-Designer",
  /** 作成者の GitHub アカウント（フッターに出す） */
  author: "itiwoja",
  /** 配信 CI（release-windows.yml）が未署名の版のリリースノートに書く文言。CI の文言を変えたらここも直す（SITE-D-25） */
  unsignedMarker: "この版はコード署名をしていません",
  /**
   * 署名を始めた最初の版（例 "1.1.0"）。未設定（null）なら、すべての版を「未署名」と出す（SITE-D-29）。
   * 署名つきの最初の版を出すときに書く（SITE-R-05）
   */
  signedSince: null as string | null,
} as const;

export const REPO_URL = `https://github.com/${SITE_CONFIG.repo}`;
export const AUTHOR_URL = `https://github.com/${SITE_CONFIG.author}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
/** exe と SHA256SUMS.txt のダウンロード URL が必ず始まる形（SITE-D-32） */
export const downloadPrefix = (version: string) => `${REPO_URL}/releases/download/v${version}/`;
