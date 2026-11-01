// 内部リンク用。BASE_URL（末尾の / の有無はビルド設定しだい）をそろえて、末尾 / 付きの URL を作る。
const base = import.meta.env.BASE_URL.replace(/\/+$/, "");
/** path は "/download/" や "/#features" のように先頭 / で渡す */
export const url = (path: string): string => `${base}${path}`;
