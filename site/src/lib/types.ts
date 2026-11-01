// サイトのデータの形（docs/design/08_database.md）。lib と画面の間の約束なので、変えるときは両方を直す。

/** SITE-TBL-002：サイトが使う配布物（installer と checksums の 2 種類だけ） */
export interface ReleaseAsset {
  name: string;
  kind: "installer" | "checksums";
  /** バイト数 */
  size: number;
  browserDownloadUrl: string;
  /** installer だけ。SHA256SUMS.txt の該当行の 64 桁（小文字） */
  sha256: string | null;
}

/** SITE-TBL-001：GitHub の Release 1 件（draft は含めない） */
export interface Release {
  /** 例 `v1.0.6` */
  tag: string;
  /** 例 `1.0.6` */
  version: string;
  name: string;
  /** ISO 8601（UTC） */
  publishedAt: string;
  prerelease: boolean;
  /** body を無害化した HTML（SITE-FR-006） */
  bodyHtml: string;
  htmlUrl: string;
  /** SITE-D-25・29：迷ったら false */
  signed: boolean;
}

/** 最新安定版（SITE-FR-001・004・005 が使う） */
export interface LatestRelease extends Release {
  installer: ReleaseAsset & { kind: "installer"; sha256: string };
  checksums: ReleaseAsset & { kind: "checksums" };
}

/** ビルド時に一度だけ取るリリース情報 */
export interface ReleaseData {
  latest: LatestRelease;
  /** 新しい順、最大 100 件（prerelease も含む） */
  releases: Release[];
}

/** SITE-TBL-005：ポリシー文書 */
export interface Policy {
  slug: "privacy" | "code-signing";
  sourcePath: string;
  /** 最初の `#` 見出し */
  title: string;
  /** 見出しを除いた本文の HTML（無害化・リンク書き換え済み） */
  bodyHtml: string;
  /** 正本の最終コミット日（ISO 8601）。git で取れなければ null */
  updatedAt: string | null;
}
