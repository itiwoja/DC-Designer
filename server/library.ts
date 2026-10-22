import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PosterSpecSchema, type PosterSpec } from "../src/schema";
import { httpError } from "./http-error";
import { GENERATED_DIR } from "./imagegen";

const ID_RE = /^[a-z0-9]{12}$/;
/** 保存先（テストでは DATA_DIR で一時ディレクトリに差し替える） */
const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL("../data/", import.meta.url));
const newId = () => randomBytes(6).toString("hex");
const now = () => new Date().toISOString();

/** 1 件 = <dir>/<id>.json の保存先。不正な ID・存在しない ID は 404。upgrade は読んだ中身を今の形に直す（古い形で保存されたもの） */
function jsonStore<T extends { id: string; updatedAt: string }>(dir: string, notFoundMessage: string, upgrade: (v: T) => T = (v) => v) {
  mkdirSync(dir, { recursive: true });
  const notFound = () => httpError(404, notFoundMessage);
  const pathOf = (id: string) => {
    if (!ID_RE.test(id)) throw notFound();
    return join(dir, `${id}.json`);
  };
  const read = (id: string): T => {
    const path = pathOf(id);
    if (!existsSync(path)) throw notFound();
    return upgrade(JSON.parse(readFileSync(path, "utf8")));
  };
  return {
    read,
    // 書き込み途中で落ちても壊れたファイルが残らないよう、一時ファイルに書いてから置き換える
    write(item: T): T {
      const path = pathOf(item.id);
      writeFileSync(path + ".tmp", JSON.stringify(item));
      renameSync(path + ".tmp", path);
      return item;
    },
    remove(id: string) {
      const path = pathOf(id);
      if (!existsSync(path)) throw notFound();
      unlinkSync(path);
    },
    /** 全件（更新が新しい順）。読めないファイルは警告して飛ばす */
    all(): T[] {
      const out: T[] = [];
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try { out.push(read(f.slice(0, -5))); } catch (e) { console.warn(`[library] ${f} を読めませんでした`, e); }
      }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  };
}

// ---------- ポスター（成果物） ----------

/** 保存したポスター。1 件 = data/posters/<id>.json */
type SavedPoster = { id: string; createdAt: string; updatedAt: string; spec: PosterSpec };

/** BGM は前は 1 曲だけをオブジェクトで持っていたので、読むときに配列にする（スキーマを通さずに返すため） */
const upgradePoster = (p: SavedPoster): SavedPoster => {
  const bgm = p.spec?.bgm as unknown;
  return bgm && !Array.isArray(bgm) ? { ...p, spec: { ...p.spec, bgm: [bgm as NonNullable<PosterSpec["bgm"]>[number]] } } : p;
};

const posters = jsonStore<SavedPoster>(join(DATA_DIR, "posters"), "ポスターが見つかりません", upgradePoster);

export const listPosters = () => posters.all();
export const getPoster = (id: string) => posters.read(id);
export const deletePoster = (id: string) => posters.remove(id);

export function createPoster(spec: unknown): SavedPoster {
  const t = now();
  return posters.write({ id: newId(), createdAt: t, updatedAt: t, spec: PosterSpecSchema.parse(spec) });
}

export function updatePoster(id: string, spec: unknown): SavedPoster {
  return posters.write({ ...posters.read(id), updatedAt: now(), spec: PosterSpecSchema.parse(spec) });
}

export function duplicatePoster(id: string): SavedPoster {
  const { spec } = posters.read(id);
  return createPoster({ ...spec, meta: { ...spec.meta, title: `${spec.meta.title} のコピー` } });
}

// ---------- 画像ファイル（public/generated） ----------

/** spec が参照している /generated/ のファイル名 */
function referencedFiles(spec: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const m = v.match(/^\/generated\/([^/?#]+)/);
      if (m) out.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(spec);
  return out;
}

type GeneratedFile = { name: string; src: string; size: number; mtime: string; uploaded: boolean; usedBy: string[] };

/** 生成・取り込み済みの画像と、それを使っているポスター。extraSpecs は保存前の編集中 spec など */
export function listGenerated(extraSpecs: unknown[] = []): GeneratedFile[] {
  const refs = listPosters().map((p) => ({ id: p.id, files: referencedFiles(p.spec) }));
  const extra = referencedFiles(extraSpecs);
  return readdirSync(GENERATED_DIR)
    .filter((f) => !f.startsWith("."))
    .map((name) => {
      const st = statSync(join(GENERATED_DIR, name));
      const usedBy = refs.filter((r) => r.files.has(name)).map((r) => r.id);
      if (extra.has(name) && !usedBy.length) usedBy.push("(編集中)");
      return { name, src: `/generated/${name}`, size: st.size, mtime: st.mtime.toISOString(), uploaded: name.startsWith("up-"), usedBy };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/** 画像を削除する。どのポスターからも使われていないものだけ */
export function deleteGenerated(names: string[], extraSpecs: unknown[] = []): string[] {
  const used = new Set(listGenerated(extraSpecs).filter((f) => f.usedBy.length).map((f) => f.name));
  const deleted: string[] = [];
  for (const name of names) {
    if (!/^[\w.-]+$/.test(name) || name.startsWith(".") || used.has(name)) continue;
    const path = join(GENERATED_DIR, name);
    if (existsSync(path)) { unlinkSync(path); deleted.push(name); }
  }
  return deleted;
}

// ---------- デッキ（PPTX のスライド・Instagram の投稿画像の並び） ----------
// スライド（画像）1 枚 = ポスター 1 件。デッキはその並び順だけを data/decks/<id>.json に持つ

/** slides: PPTX エディターモード（無い古いデッキもこれ）／ instagram: Instagram の投稿（カルーセル） */
export type DeckKind = "slides" | "instagram";
type Deck = { id: string; name: string; kind?: DeckKind; createdAt: string; updatedAt: string; slides: string[] };
type DeckSlide = { id: string; title: string; updatedAt: string; spec?: PosterSpec };
type DeckView = Omit<Deck, "slides"> & { slides: DeckSlide[] };

const decks = jsonStore<Deck>(join(DATA_DIR, "decks"), "デッキが見つかりません");

/** 削除済みのポスターは並びから外して返す。withSpecs なら各スライドの spec も付ける（エディタが全スライドをまとめて開く） */
function viewDeck(d: Deck, withSpecs = false): DeckView {
  const slides: DeckSlide[] = [];
  for (const id of d.slides) {
    try {
      const p = posters.read(id);
      slides.push({ id, title: p.spec.meta.title, updatedAt: p.updatedAt, ...(withSpecs ? { spec: p.spec } : {}) });
    } catch { /* 削除済み */ }
  }
  return { ...d, slides };
}

/** 更新日時を付けて保存し、表示用の形で返す */
const saveDeck = (d: Deck) => viewDeck(decks.write({ ...d, updatedAt: now() }));

/** スライド（spec の配列）からポスターとデッキをまとめて作る */
export function createDeck(name: unknown, specs: unknown, kind?: unknown): DeckView {
  if (!Array.isArray(specs) || !specs.length) throw httpError(400, "スライドがありません");
  const parsed = specs.map((s) => PosterSpecSchema.parse(s));
  const t = now();
  const instagram = kind === "instagram";
  return viewDeck(decks.write({
    id: newId(), name: String(name || (instagram ? "Instagram 投稿" : "プレゼンテーション")), ...(instagram ? { kind: "instagram" as const } : {}),
    createdAt: t, updatedAt: t, slides: parsed.map((s) => createPoster(s).id),
  }));
}

export const getDeck = (id: string) => viewDeck(decks.read(id));

/** 全デッキ（更新が新しい順）。成果物画面でプロジェクトとしてまとめて表示する */
export const listDecks = (): DeckView[] => decks.all().map((d) => viewDeck(d));

/** デッキを複製（スライドも全部複製して新しいデッキにする） */
export function duplicateDeck(id: string): DeckView {
  const d = decks.read(id);
  const slides: string[] = [];
  for (const sid of d.slides) {
    try { slides.push(createPoster(posters.read(sid).spec).id); } catch { /* 削除済みのスライドは飛ばす */ }
  }
  const t = now();
  return viewDeck(decks.write({ id: newId(), name: `${d.name} のコピー`, ...(d.kind ? { kind: d.kind } : {}), createdAt: t, updatedAt: t, slides }));
}

/** デッキを削除（スライドのポスターもまとめて消す）。消したスライドの ID を返す */
export function deleteDeck(id: string): string[] {
  const d = decks.read(id);
  const deleted: string[] = [];
  for (const sid of d.slides) {
    try { deletePoster(sid); deleted.push(sid); } catch { /* 既に無い */ }
  }
  decks.remove(id);
  return deleted;
}

/** ポスターが入っているデッキ（無ければ null）。withSpecs なら全スライドの spec も付ける */
export function deckOfPoster(posterId: string, withSpecs = false): DeckView | null {
  const d = decks.all().find((d) => d.slides.includes(posterId));
  return d ? viewDeck(d, withSpecs) : null;
}

/** 名前・並び順の変更。slides は既存のスライドの並べ替え（外したものはデッキから外れるだけで、ポスターは残る） */
export function updateDeck(id: string, body: { name?: unknown; slides?: unknown }): DeckView {
  const d = decks.read(id);
  if (typeof body.name === "string" && body.name.trim()) d.name = body.name.trim();
  if (Array.isArray(body.slides)) {
    const ids = body.slides.map(String);
    if (new Set(ids).size !== ids.length) throw httpError(400, "スライドIDが重複しています");
    d.slides = ids.filter((s) => d.slides.includes(s));
  }
  return saveDeck(d);
}

/** スライドを追加（after の直後、無ければ末尾）。spec が無ければ after のスライドを複製 */
export function addDeckSlide(id: string, body: { spec?: unknown; after?: unknown }): { deck: DeckView; poster: SavedPoster } {
  const d = decks.read(id);
  const after = typeof body.after === "string" ? body.after : null;
  const poster = body.spec ? createPoster(body.spec) : after ? duplicatePoster(after) : null;
  if (!poster) throw httpError(400, "spec か after が必要です");
  const i = after ? d.slides.indexOf(after) : -1;
  d.slides.splice(i >= 0 ? i + 1 : d.slides.length, 0, poster.id);
  return { deck: saveDeck(d), poster };
}

/** スライドを削除（ポスターごと消す） */
export function removeDeckSlide(id: string, posterId: string): DeckView {
  const d = decks.read(id);
  // 別のデッキのポスターを消さないよう、このデッキのスライドかを先に確かめる
  if (!d.slides.includes(posterId)) throw httpError(404, "このデッキのスライドではありません");
  d.slides = d.slides.filter((s) => s !== posterId);
  try { deletePoster(posterId); } catch { /* 既に無い */ }
  return saveDeck(d);
}
