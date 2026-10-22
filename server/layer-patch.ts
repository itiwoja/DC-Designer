import { PosterSpecSchema, type PosterSpec } from "../src/schema";
import { shiftRuns, type ColorRun } from "../src/textRuns";

/**
 * 再現の仕上げで AI が返す「直したところだけ」の差分。
 * spec 全体を書き直させると出力が長くなり時間がかかるので、変えたレイヤーだけを返させてサーバー側で当てる
 */
export type LayerPatch = {
  /** 既存レイヤーの変更。id で指定し、変えるフィールドだけを書く（null はそのフィールドを消す。type を変えるときはレイヤー全体を書く） */
  update?: Record<string, unknown>[];
  /** 新しいレイヤー（全体を書く） */
  add?: Record<string, unknown>[];
  /** 消すレイヤーの id */
  remove?: string[];
  /** 重なり順を変える・追加したレイヤーの位置を決めるときの、最終的な全レイヤーの id（先頭が最背面）。無ければ既存の順のまま、追加分は最前面 */
  order?: string[];
  /** meta の変更（imageStyle など。大きさは変えられない） */
  meta?: Record<string, unknown>;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ids = (v: unknown, name: string) => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${name} は id の配列にしてください`);
  return v as string[];
};
const objs = (v: unknown, name: string) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every(isObj)) throw new Error(`${name} はレイヤーの配列にしてください`);
  return v as Record<string, unknown>[];
};

/** 浅いマージ（null はフィールドを消す） */
function merge(base: Record<string, unknown>, patch: Record<string, unknown>) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** 差分が空（直すところなし）か */
export const isEmptyPatch = (p: LayerPatch) =>
  !p.update?.length && !p.add?.length && !p.remove?.length && !p.order?.length && !(p.meta && Object.keys(p.meta).length);

/** JSON を LayerPatch として読む（形が違えば AI に直させるためのエラーを投げる） */
export function parsePatch(j: unknown): LayerPatch {
  if (!isObj(j)) throw new Error("changes はオブジェクトにしてください");
  return {
    update: objs(j.update, "changes.update"),
    add: objs(j.add, "changes.add"),
    remove: ids(j.remove, "changes.remove") ?? [],
    order: ids(j.order, "changes.order"),
    meta: j.meta == null ? undefined : isObj(j.meta) ? j.meta : (() => { throw new Error("changes.meta はオブジェクトにしてください"); })(),
  };
}

/** spec に差分を当てて検証した spec を返す。おかしな差分は AI に直させるためのエラーにする */
export function applyLayerPatch(spec: PosterSpec, patch: LayerPatch): PosterSpec {
  const layers = spec.layers.map((l) => ({ ...l }) as Record<string, unknown>);
  const index = new Map(layers.map((l, i) => [l.id as string, i]));
  const errors: string[] = [];

  for (const u of patch.update ?? []) {
    const i = index.get(u.id as string);
    if (i === undefined) { errors.push(`update の id "${String(u.id)}" は現在の PosterSpec にありません（新しいレイヤーなら add に書く）`); continue; }
    layers[i] = u.type !== undefined && u.type !== layers[i].type ? { ...u } : merge(layers[i], u);
    // 文字だけ書き換えて部分色に触れていなければ、部分色の位置を新しい文字に合わせる
    const l = layers[i];
    if (l.type === "text" && "text" in u && !("colorRuns" in u) && typeof u.text === "string" && Array.isArray(l.colorRuns) && l.colorRuns.length) {
      const before = spec.layers.find((x) => x.id === u.id) as { text?: string } | undefined;
      const runs = shiftRuns(l.colorRuns as ColorRun[], before?.text ?? "", u.text);
      if (runs.length) l.colorRuns = runs;
      else delete l.colorRuns;
    }
  }
  const removed = new Set(patch.remove ?? []);
  for (const id of removed) if (!index.has(id)) errors.push(`remove の id "${id}" は現在の PosterSpec にありません`);
  for (const a of patch.add ?? []) {
    if (typeof a.id !== "string" || !a.id) errors.push("add のレイヤーには id が必要です");
    else if (index.has(a.id) && !removed.has(a.id)) errors.push(`add の id "${a.id}" は既にあります（既存レイヤーの変更なら update に書く）`);
  }
  if (errors.length) throw new Error(errors.join("\n"));

  let next = [...layers.filter((l) => !removed.has(l.id as string)), ...(patch.add ?? [])];
  if (patch.order?.length) {
    const byId = new Map(next.map((l) => [l.id as string, l]));
    const missing = [...byId.keys()].filter((id) => !patch.order!.includes(id));
    const unknown = patch.order.filter((id) => !byId.has(id));
    if (missing.length || unknown.length || new Set(patch.order).size !== patch.order.length) {
      throw new Error(`order には最終的な全レイヤーの id を 1 回ずつ並べてください${missing.length ? `（抜け: ${missing.join(", ")}）` : ""}${unknown.length ? `（存在しない id: ${unknown.join(", ")}）` : ""}`);
    }
    next = patch.order.map((id) => byId.get(id)!);
  }
  const meta = { ...merge(spec.meta, patch.meta ?? {}), width: spec.meta.width, height: spec.meta.height };
  return PosterSpecSchema.parse({ ...spec, meta, layers: next });
}
