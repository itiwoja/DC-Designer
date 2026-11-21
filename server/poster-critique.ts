import type { PosterSpec } from "../src/schema";
import { fixScrollTargets } from "../src/animation";
import type { ImageRef } from "./chatgpt";
import { applyLayerPatch, isEmptyPatch, parsePatch } from "./layer-patch";
import { generateJson, type OnProgress } from "./planner";

/**
 * ポン出し（planPoster）の自己添削: 一度描画したポスターの画像を見せて、デザインの欠点を自分で洗い出して直させる。
 * 1 枚目が現在の PosterSpec の描画結果。spec 全体は書き直させず、直したレイヤーだけを差分（LayerPatch）で返させてここで当てる。
 * 返り値の spec は直したとき（直すところが無ければ無し）
 */
export async function critiquePoster(opts: { render: ImageRef; spec: PosterSpec; brief?: string; onProgress?: OnProgress; signal?: AbortSignal }): Promise<{ reply: string; spec?: PosterSpec }> {
  const { width: w, height: h } = opts.spec.meta;
  const brief = opts.brief?.trim();
  const text = [
    `1 枚目の画像は、下の PosterSpec を描画した結果です（${w}×${h}px のポスターの座標と同じ比率）。あなたは熟練のアートディレクターです。まず紙面を見て問題を洗い出し、それから PosterSpec を直してください。`,
    [
      "# 見る観点",
      "- 文字のはみ出し・意図しない折り返し・切れ（枠や紙面の外に出ていないか、1 文字だけ次の行に落ちていないか）",
      "- 要素どうしの意図しない重なり（文字が写真や図形に埋もれていないか）",
      "- 整列のずれ（左端・中心がそろっていない）",
      "- マージン不足・余白の偏り（詰まっている所と、スカスカな所）",
      "- 情報の階層（いちばん目立つべきものが目立っているか。サイズ差が足りない、または段階が多すぎる）",
      "- 可読性（背景との明度差が足りない、文字が小さすぎる）",
      "- 色が多すぎる・ちぐはぐ",
      "- 書体の数が多すぎる",
      "- 意図のない飾り・ありきたりな飾りを置きすぎていないか（無くても成り立つものは消す）",
      "- 紙面全体の重心とバランス",
    ].join("\n"),
    [
      "# 守ること",
      "- 直すのは見た目だけです。文言（日時・場所・名前など）の内容は変えない。",
      "- 大きく作り直したほうがよいと思ったら、位置・大きさ・色・書体を大胆に動かしてよい。",
      "- 画像レイヤーで斜線模様の点線の枠になっているものは、まだ生成していない画像の場所です（生成すると、その枠の位置に画像が入ります）。枠として扱い、位置・大きさ・形は直してよいが、src は書かない。生成済みの画像の src も変えない。",
      "- 迷う小さな違いは直さない。はっきり良くなる所だけを直す。",
    ].join("\n"),
    brief ? `# ブリーフ（このポスターの依頼内容。内容・文言はこれに沿ったまま）\n${brief}` : "",
    "# 現在の PosterSpec",
    JSON.stringify(opts.spec),
    "# 出力（直したところだけを書く）",
    [
      "次の形の JSON のみを出力してください。直さないレイヤーは書かないでください（現在のまま残ります）。",
      '{"reply": 見つけた主な問題と何を直したかを日本語 1〜3 文で, "changes": {',
      '  "update": [{"id": 既存レイヤーの id, 変えるフィールドだけ（値はそのフィールドの新しい値全体。fill・outlines・children なども丸ごと書く。フィールドを消すなら null）}],',
      '  "add": [新しいレイヤー全体（一意な id 付き）],',
      '  "remove": [消すレイヤーの id],',
      '  "order": 重なり順を変える・追加したレイヤーを最前面以外に置くときだけ、最終的な全レイヤーの id を最背面から順に並べた配列（それ以外は書かない）,',
      '  "meta": imageStyle などを変えるときだけ',
      "}}",
      'もう直すところが無ければ "changes" は null にしてください。',
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
  return generateJson(
    { role: "user", text, images: [{ ...opts.render, detail: "high" }] },
    (j) => {
      const o = j as { reply?: unknown; changes?: unknown };
      const reply = typeof o?.reply === "string" ? o.reply : "";
      if (o?.changes == null) return { reply };
      const patch = parsePatch(o.changes);
      return isEmptyPatch(patch) ? { reply } : { reply, spec: fixScrollTargets(applyLayerPatch(opts.spec, patch)) };
    },
    '{"reply", "changes"} の JSON ',
    opts.onProgress,
    opts.signal,
  );
}
