// 表示用の整形（SITE-FR-004・006）。どれも純粋関数。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** ISO 8601 を JST の `2026年10月30日` にする（月日は 0 埋めしない） */
export function formatDateJa(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new Error(`日付を読めません（${iso}）`);
  const d = new Date(t + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/** バイト数を `118.1 MB` にする（1 MB = 1,048,576 バイト、小数 1 桁） */
export function formatMB(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** 版から更新履歴のアンカーを作る（`1.0.6` → `v1-0-6`） */
export function versionAnchor(version: string): string {
  return `v${version.replace(/[^0-9A-Za-z]+/g, "-")}`;
}
