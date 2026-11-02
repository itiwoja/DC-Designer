import type { Layer, Paint, PosterSpec } from "../schema";

const SKIP = new Set(["", "none", "transparent", "inherit", "currentcolor"]);

/**
 * スライドでよく使われている色を、多い順・重複なしで返す（AI に配色を伝える要約用）。
 * 背景レイヤーの fill は 2 回分に数えて上位に来やすくする。影の色は含めない。themeOverride.colors は「$トークン=色」の形で先頭に置く
 */
export function slidePalette(spec: PosterSpec, max = 12): string[] {
  const counts = new Map<string, { color: string; n: number }>();
  const add = (c: unknown, weight = 1) => {
    if (typeof c !== "string") return;
    const color = c.trim();
    const key = color.toLowerCase();
    if (SKIP.has(key)) return;
    const e = counts.get(key);
    if (e) e.n += weight;
    else counts.set(key, { color, n: weight });
  };
  const addPaint = (p: Paint | undefined, weight = 1) => {
    if (!p) return;
    if (typeof p === "string") add(p, weight);
    else for (const s of p.stops ?? []) add(s.color, weight);
  };
  const walk = (layers: Layer[]) => {
    for (const l of layers) {
      switch (l.type) {
        case "background": addPaint(l.fill, 2); break;
        case "shape": addPaint(l.fill); add(l.stroke); break;
        case "text":
          addPaint(l.fill);
          for (const r of l.colorRuns ?? []) add(r.color);
          for (const o of l.outlines ?? []) add(o.color);
          break;
        case "group": walk(l.children ?? []); break;
      }
    }
  };
  walk(spec.layers ?? []);
  // テーマの色の上書きは、どのトークンの色か分かるよう「$primary=#F08C00」の形で先頭に置く（上限で落ちないように）
  const overrides = Object.entries(spec.themeOverride?.colors ?? {}).filter(([, v]) => !SKIP.has(v.trim().toLowerCase())).map(([k, v]) => `$${k}=${v.trim()}`);
  // 多い順（同数は出てきた順）
  const out = [...overrides, ...[...counts.values()].sort((a, b) => b.n - a.n).map((e) => e.color)];
  return out.slice(0, max);
}
