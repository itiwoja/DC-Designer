/** デッキのページ番号（スライド隅の「3」「P.3」「3 / 20」などのテキストレイヤー）を数え直す。React 非依存 */
import type { Layer, PosterSpec, TextLayerT } from "../schema";

/**
 * 「スライド番号の並びを直して」「右下の番号がずれてるから振り直して」のような、デッキ全体のページ番号を直す指示か。
 * 「ステップの番号を直して」のような番号一般の指示は拾わないよう、ページ番号を指す語か、隅・全体を指す語を必須にする
 */
export function isRenumberRequest(text: string): boolean {
  const t = text.normalize("NFKC");
  const pageNo = /(?:スライド|ページ)\s*(?:の)?\s*(?:番号|ナンバー|No)|ノンブル|通し番号|ページ数|page\s*numbers?|slide\s*numbers?/i.test(t);
  const where = /番号/.test(t) && /(?:右下|左下|下の|隅|全体|全部|すべて|全て|各スライド|全スライド|全ページ)/.test(t);
  const fix = /(?:振り直|ふり直|振りなお|ふりなお|並び|順番|順序|連番|ずれ|ズレ|合って|あって|合わせ|揃え|そろえ|整え|正し|直|修正|おかし|違|ちが|バラバラ|ばらばら|renumber|fix)/i.test(t);
  return (pageNo || where) && fix;
}

/** ページ番号として読めるテキスト（「3」「P.3」「p3」「- 3 -」「3 / 20」「3/20」） */
const PAGE_TEXT = /^(?:p\.?\s*|-\s*)?(\d{1,3})(?:\s*-|\s*\/\s*(\d{1,3}))?$/i;

type Found = { path: number[]; layer: TextLayerT; number: number; total?: number; x: number; y: number };

/** レイヤーを（グループの中も）絶対座標で列挙する。path は layers / children の添字の並び */
function* walk(layers: Layer[], ox = 0, oy = 0, path: number[] = []): Generator<{ layer: Layer; path: number[]; x: number; y: number }> {
  for (const [i, l] of layers.entries()) {
    if (l.type === "background" || l.visible === false) continue;
    const p = [...path, i];
    if (l.type === "group") yield* walk(l.children, ox + l.x, oy + l.y, p);
    else yield { layer: l, path: p, x: ox + l.x, y: oy + l.y };
  }
}

/**
 * スライドのページ番号のテキストレイヤーを探す。下端 15% かつ左右どちらかの端 25% に中心がある、番号だけのテキストのうち、
 * 下の隅にいちばん近いもの。本文中の「手順 4」の丸数字などを拾わないよう、位置と文面の両方で絞る
 */
export function findPageNumber(spec: PosterSpec): Found | null {
  const { width: W, height: H } = spec.meta;
  let best: Found | null = null, bestDist = Infinity;
  for (const { layer, path, x, y } of walk(spec.layers)) {
    if (layer.type !== "text") continue;
    const m = layer.text.trim().match(PAGE_TEXT);
    if (!m) continue;
    const cx = x + layer.w / 2, cy = y + layer.h / 2;
    if (cy < H * 0.85 || (cx > W * 0.25 && cx < W * 0.75)) continue;
    const dist = Math.min(cx, W - cx) + (H - cy);
    if (dist < bestDist) {
      bestDist = dist;
      best = { path, layer, number: Number(m[1]), total: m[2] ? Number(m[2]) : undefined, x, y };
    }
  }
  return best;
}

/** 番号の部分だけを差し替える（「P.」などの書式や「/ 総数」は残し、総数は total に合わせる） */
const withNumber = (text: string, n: number, total: number) =>
  text.replace(/\d+/, String(n)).replace(/(\/\s*)\d+/, `$1${total}`);

function replaceAt(layers: Layer[], path: number[], fn: (l: Layer) => Layer): Layer[] {
  const [i, ...rest] = path;
  return layers.map((l, j) => (j !== i ? l : rest.length && l.type === "group" ? { ...l, children: replaceAt(l.children, rest, fn) } : fn(l)));
}

export type RenumberResult = {
  specs: PosterSpec[];
  /** 番号を書き換えたスライド（1 始まり） */
  changed: { slide: number; from: number; to: number }[];
  /** ページ番号のテキストが見つからなかったスライド（1 始まり） */
  missing: number[];
  /** 番号の無いスライドに足すときの見本（いちばん多くのスライドで使われている位置・書式の番号） */
  template: { layer: TextLayerT; x: number; y: number; width: number; height: number } | null;
};

/**
 * 各スライドのページ番号を、デッキの並び順（1 始まり）に合わせて書き換える。
 * 総数付き（「3 / 20」）の総数もスライド枚数に合わせる。変わらないスライドは同じオブジェクトのまま返す
 */
export function renumberPages(specs: PosterSpec[], deckName?: string): RenumberResult {
  const found = specs.map(findPageNumber);
  const total = specs.length;
  const changed: RenumberResult["changed"] = [];
  const missing: number[] = [];
  const out = specs.map((spec, i) => {
    const n = i + 1;
    let next = renameTitle(spec, deckName, n);
    const f = found[i];
    if (!f) { missing.push(n); return next; }
    const text = withNumber(f.layer.text, n, total);
    if (text === f.layer.text) return next;
    changed.push({ slide: n, from: f.number, to: n });
    next = { ...next, layers: replaceAt(next.layers, f.path, (l) => ({ ...l, text }) as Layer) };
    return next;
  });
  // 見本: 位置（10px 単位）と書式がいちばん多く一致する番号
  const key = (f: Found) => [Math.round(f.x / 10), Math.round(f.y / 10), f.layer.size, f.layer.font, JSON.stringify(f.layer.fill)].join("|");
  const counts = new Map<string, number>();
  for (const f of found) if (f) counts.set(key(f), (counts.get(key(f)) ?? 0) + 1);
  let template: RenumberResult["template"] = null, top = 0;
  for (const [i, f] of found.entries()) {
    if (f && (counts.get(key(f)) ?? 0) > top) {
      top = counts.get(key(f))!;
      template = { layer: f.layer, x: f.x, y: f.y, width: specs[i].meta.width, height: specs[i].meta.height };
    }
  }
  return { specs: out, changed, missing, template };
}

/** PPTX 読み込み時の「デッキ名 3」形式のタイトルなら、番号を今の並びに合わせる */
function renameTitle(spec: PosterSpec, deckName: string | undefined, n: number): PosterSpec {
  const m = deckName ? spec.meta.title.match(/^(.*) (\d+)$/) : null;
  if (!m || m[1] !== deckName || Number(m[2]) === n) return spec;
  return { ...spec, meta: { ...spec.meta, title: `${deckName} ${n}` } };
}

/** 見本の番号を複製して、番号の無いスライドの最前面に足す（スライドの大きさが違えば位置を比率で合わせる） */
export function addPageNumber(spec: PosterSpec, template: NonNullable<RenumberResult["template"]>, n: number, total: number): PosterSpec {
  const sx = spec.meta.width / template.width, sy = spec.meta.height / template.height;
  const ids = new Set([...walk(spec.layers)].map((e) => e.layer.id));
  let id = "page-number", k = 2;
  while (ids.has(id)) id = `page-number-${k++}`;
  const layer: TextLayerT = {
    ...template.layer, id, name: "ページ番号",
    x: template.x * sx, y: template.y * sy,
    text: withNumber(template.layer.text, n, total),
  };
  return { ...spec, layers: [...spec.layers, layer] };
}
