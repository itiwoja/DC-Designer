import { z } from "zod";
import { MAX_REFERENCES, MAX_REFERENCE_DATA_BYTES } from "../src/referenceLimits";
import { httpError } from "./http-error";
import { saveUpload } from "./imagegen";
import type { ImageRef } from "./chatgpt";
import type { PosterSpec } from "../src/schema";

export type PosterReference = ImageRef & { name?: string; src?: string; width?: number; height?: number };

const References = z.array(z.object({
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  data: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  name: z.string().max(300).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
})).max(MAX_REFERENCES);

export function parseReferences(value: unknown) {
  if (value === undefined) return undefined;
  const parsed = References.safeParse(value);
  if (!parsed.success) throw httpError(400, `参考資料は画像形式で ${MAX_REFERENCES} 枚まで指定してください`);
  if (parsed.data.reduce((sum, r) => sum + r.data.length, 0) > MAX_REFERENCE_DATA_BYTES) throw httpError(400, "参考資料の合計サイズが大きすぎます。枚数やファイルサイズを減らしてください");
  return parsed.data;
}

/** AIが配置にも使えるよう、実データを画像配信先へ保存してからURLを渡す。 */
export function storeReferences(value: unknown): PosterReference[] | undefined {
  return parseReferences(value)?.map((r) => ({ ...r, src: saveUpload(r.mediaType, r.data).src }));
}

export function referenceSources(references?: PosterReference[]): string {
  const saved = references?.flatMap((r, i) => r.src ? [{ number: i + 1, id: `user-image-${i + 1}`, name: r.name, src: r.src, width: r.width, height: r.height }] : []) ?? [];
  return saved.length ? [
    "# 添付画像の保存済みURL（画像の順番）",
    JSON.stringify(saved),
    "添付画像そのものを配置するときは、このsrcをそのまま使ってください。ファイル名や架空のURLをsrcに書かず、添付画像には画像生成用assetを作らないでください。",
    '「添付を配置して」「このロゴを入れて」などは雰囲気の参考ではなく、原画像を使う指示です。type: "image", src: 上記URL の独立したレイヤーにし、ロゴ内の文字も含めて描き直し・画像生成・色の変更をしないでください。',
    'ロゴは fit: "contain" で全体を見せ、トリミングや引き伸ばしをしないでください。元の width / height があるときは、その縦横比にレイヤーの w / h も合わせてください。',
    "ロゴの位置・大きさの指定があれば優先してください。「いい感じに」だけなら、既存の文字やページ番号を避け、隅に控えめなサイズ（幅はスライド幅の 10〜15% を目安）で、縁からスライド短辺の 3〜5% の余白を取り、キャンバス内に収めてください。編集では指示と無関係な内容は変更しないでください。",
  ].join("\n") : "";
}

/** AIが返した添付ファイル名を実URLへ戻し、新規の架空ファイル名は再生成させる。 */
export function resolveReferenceSources(spec: PosterSpec, references?: PosterReference[], previous?: PosterSpec): PosterSpec {
  const saved = references?.filter((r) => r.src) ?? [];
  const original = new Set<string>();
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, v] of Object.entries(value)) {
      if (key === "src" && typeof v === "string") original.add(v);
      else collect(v);
    }
  };
  collect(previous);
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    const next: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key !== "src" || typeof v !== "string") { next[key] = rewrite(v); continue; }
      const bare = /^(?:\.\/)?[^/:\\]+$/.test(v);
      const filename = v.replace(/^\.\//, "");
      // 正しいURLはそのまま。同名の添付は user-image-N の id を優先して区別する。
      let reference = saved.find((r) => r.src === v);
      if (!reference && bare) {
        const id = String((value as { id?: unknown }).id ?? "").match(/^user-image-(\d+)$/);
        if (id) reference = references?.[Number(id[1]) - 1];
      }
      if (!reference) reference = saved.find((r) => r.name === filename || r.src?.slice("/generated/".length) === filename);
      if (bare && reference?.src) next[key] = reference.src;
      else if (bare && !original.has(v)) throw new Error(`画像src「${v}」は保存済みURLではありません。添付画像は指定された /generated/ URLを使ってください`);
      else next[key] = v;
    }
    // 添付画像は生成待ちとして扱わない。
    if (typeof next.src === "string" && saved.some((r) => r.src === next.src)) delete next.asset;
    return next;
  };
  return rewrite(spec) as PosterSpec;
}
