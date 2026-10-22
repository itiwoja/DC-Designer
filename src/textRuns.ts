/**
 * テキストの一部だけの色（colorRuns）。位置は text の文字位置（JS 文字列の添字。改行 "\n" も 1 文字）で、
 * [start, end) の範囲をその色で塗る。範囲外の文字はレイヤー全体の fill のまま。
 */
export type ColorRun = { start: number; end: number; color: string };

/** 1 文字ずつの色に展開する（範囲外は undefined） */
function expand(runs: ColorRun[] | undefined, length: number): (string | undefined)[] {
  const out: (string | undefined)[] = new Array(length).fill(undefined);
  for (const r of runs ?? []) {
    for (let i = Math.max(0, r.start); i < Math.min(length, r.end); i++) out[i] = r.color;
  }
  return out;
}

/** 1 文字ずつの色を範囲にまとめ直す（隣り合う同じ色はつなぐ） */
function compress(colors: (string | undefined)[]): ColorRun[] {
  const out: ColorRun[] = [];
  colors.forEach((color, i) => {
    if (!color) return;
    const last = out[out.length - 1];
    if (last && last.end === i && last.color === color) last.end = i + 1;
    else out.push({ start: i, end: i + 1, color });
  });
  return out;
}

/** [start, end) を color で塗る。color が null なら部分色を外して全体の色に戻す */
export function paintRange(runs: ColorRun[] | undefined, text: string, start: number, end: number, color: string | null): ColorRun[] {
  const colors = expand(runs, text.length);
  for (let i = Math.max(0, start); i < Math.min(text.length, end); i++) colors[i] = color ?? undefined;
  return compress(colors);
}

/** [start, end) がすべて同じ部分色ならその色（全体の色のままなら null、混ざっていれば undefined） */
export function rangeColor(runs: ColorRun[] | undefined, text: string, start: number, end: number): string | null | undefined {
  const colors = expand(runs, text.length).slice(start, end);
  if (!colors.length) return undefined;
  return colors.every((c) => c === colors[0]) ? colors[0] ?? null : undefined;
}

/**
 * 文字を打ち替えたときに部分色の位置を合わせる。前後の一致部分はそのまま、
 * 書き換わった部分の新しい文字は、置き換えなら置き換えられた先頭の文字の色、挿入なら直前の文字の色を引き継ぐ
 */
export function shiftRuns(runs: ColorRun[] | undefined, before: string, after: string): ColorRun[] {
  if (!runs?.length) return [];
  const colors = expand(runs, before.length);
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const oldEnd = before.length - s, inserted = after.length - s - p;
  const inherit = oldEnd > p ? colors[p] : p > 0 ? colors[p - 1] : colors[0];
  return compress([...colors.slice(0, p), ...new Array(inserted).fill(inherit), ...colors.slice(oldEnd)]);
}

/** text を差し替えるときのパッチ（部分色があれば位置を合わせて一緒に直す） */
export function withText(layer: { text: string; colorRuns?: ColorRun[] }, text: string): { text: string; colorRuns?: ColorRun[] } {
  if (!layer.colorRuns?.length) return { text };
  const colorRuns = shiftRuns(layer.colorRuns, layer.text, text);
  return { text, colorRuns: colorRuns.length ? colorRuns : undefined };
}

/** 行ごとに、色の切れ目で分けた断片（color が無い断片は全体の色） */
export function lineSegments(text: string, runs: ColorRun[] | undefined): { text: string; color?: string }[][] {
  const colors = runs?.length ? expand(runs, text.length) : null;
  let offset = 0;
  return text.split("\n").map((line) => {
    const segs: { text: string; color?: string }[] = [];
    for (let i = 0; i < line.length; i++) {
      const color = colors?.[offset + i];
      const last = segs[segs.length - 1];
      if (last && last.color === color) last.text += line[i];
      else segs.push({ text: line[i], color });
    }
    offset += line.length + 1;
    return segs;
  });
}
