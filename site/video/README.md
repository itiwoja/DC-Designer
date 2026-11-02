# 紹介サイトのデモ動画（Remotion）

紹介サイト（`site/`）の媒体の枠（[docs/design/06_ux_design.md「媒体の枠」](../../docs/design/06_ux_design.md#媒体の枠)）に入れる素材を作る。サイトとは依存を共有しない別のパッケージで、サイトのビルド・テスト・`astro check` には入らない。

| 出力 | 寸法・形式 | 置き場所 |
|---|---|---|
| デモ動画 | 1920×1080・30fps・約 27 秒・ナレーション・BGM・効果音つき。MP4（H.264＋AAC）と WebM（VP9＋Opus） | `site/src/assets/media/demo.mp4` / `demo.webm` |
| 動画のポスター画像（再生前に見える 1 枚） | 1920×1080 PNG（サイトでは WebP にして配る） | `site/src/assets/media/demo-poster.png` |
| ヒーロー画像 | 1600×1000 PNG（ビルドで AVIF / WebP） | `site/src/assets/media/hero.png` |
| 機能画像（ポスター作成・スライド作成のカード） | 1200×750 PNG（ビルドで AVIF / WebP）。実画面のキャンバスと右のパネルに寄せて切り出し、下の帯に注記 | `site/src/assets/media/feature-poster.png` / `feature-slides.png` |
| OGP 画像（SNS で共有したときの 1 枚） | 1200×630 PNG。ヒーロー画像と同じ絵（`src/Still.tsx`）。配る PNG はビルドで色数を減らす（約 107KB） | `site/src/assets/media/ogp.png` |

## 作り直し方

```bash
cd site/video
npm install            # esbuild の install script は `npm install-scripts approve esbuild` で許可する
npm run studio         # 画面で確かめながら直す
npm run render         # 6 つを書き出して site/src/assets/media/ に置く（scripts/render.sh）
```

- フォント（Mochiy Pop One・Noto Sans JP、計 15MB）はリポジトリに入れず、`npm run studio` / `npm run render` の前に `scripts/fetch-fonts.sh` が google/fonts から取る。
- WSL では Playwright の Chromium（`~/.cache/ms-playwright/chromium_headless_shell-*`）を使う（`remotion.config.ts`）。`libnspr4.so` が無いと言われたら、sudo なしで展開したライブラリを `LD_LIBRARY_PATH` に入れる（`render.sh` は `~/.local/chromium-libs` があれば自動で入れる）。
- 配置は 1280×720 の座標で組み、`--scale=1.5` で 1920×1080 に書き出す。アプリの画面は 1600×1000 を 3 倍（入力欄は 4 倍）で撮ってあり、配置は 2 倍の 3200×2000 の座標で書く（ファイルの実寸とは別）。
- 場面の並びと長さは `src/Demo.tsx` の `SCENES`。機能画像の切り出す範囲は `src/Feature.tsx` の `FEATURE_SHOTS`（カードでは 360〜520px 幅に縮むので、画面全体ではなく寄せて見せる）。文字は `src/Demo.tsx`・`src/Still.tsx`・`src/Feature.tsx`、色はサイトのトークンと同じ値の `src/theme.ts`。

| 秒 | 場面 | ナレーション | 素材 | 効果音 |
|---|---|---|---|---|
| 0.0〜3.2 | ● ▲ ■ が落ちて「AIに頼んで、」 | ポスターづくりは、AIに頼もう。 | 演出 | 図形の着地にポップ、文字が跳ねるたびに小さな刻み |
| 3.2〜7.7 | 新規作成の欄に 1 文字ずつ入り、「レイアウトを生成」を押す | 作りたいものを、文章で伝えるだけ。 | 実画面（本物の入力欄に 1 文字ずつ入れ、2 文字ごとに撮った 80 コマ。入力欄が自動で下へ送られるのも実際の動き） | タイピング（約 2.9 秒）、ボタンでクリック |
| 7.7〜10.7 | 「ChatGPT がレイアウトを設計中…」 | AIが、レイアウトを組み立てます。 | 実画面（撮影のときは `/api/plan` をブラウザの中で止め、AI には送っていない） | ウーッシュ、少しずつ高まるライザー |
| 10.7〜14.7 | 22 枚のレイヤーが下から順に重なる | 文字も写真も、レイヤーに分かれているから、 | 実際に生成したポスターのレイヤーを、下から 1〜N 枚だけで描画したもの | 1 枚ごとに小さな刻み、22 枚でチャイム |
| 14.7〜18.2 | 望遠鏡に重なった吹き出しを選び、ドラッグで正しい位置へ運ぶ | 気になるところだけ、自分で直せます。 | 実画面（吹き出しをわざとずらして保存してから、実際にドラッグした様子を連続で撮ったもの） | 選ぶ所でクリック、離す所で刻み |
| 18.2〜22.0 | スライドの表紙 | スライドも作れて、パワーポイントで書き出せます。 | 実画面（実際に生成したもの） | ウーッシュ、寄り切った所で確認音 |
| 22.0〜26.8 | PDF・PNG・PPTX とロゴ、クレジット | ディー・シー・デザイナー。無料で使えます。（効果音が鳴り終わってから） | 演出 | 札ごとにポップ、ロゴでチャイム |

- ナレーション：台本は `narration/lines.json`。`scripts/voice_vv.py` で VOICEVOX ENGINE（0.26.0、`127.0.0.1:50021`）から作る。
  ```bash
  uv run --with requests python scripts/voice_vv.py narration/lines.json public/vo --speaker 8 --speed 0.9
  ```
  話す速さは 1 秒あたり 5.6〜7.1 文字（CM 向けの 7 文字以下）。「DC-Designer」は「ディーシーデザイナー」と書くと Whisper に「PC デザイナー」と聞き取られたので、「ディー・シー・デザイナー」と書いて区切りの間を 0.12 秒に詰めた。声を作り直して長さが変わったら、`src/Demo.tsx` の `SCENES` の `len`（場面の長さ）と `voAt`（声の始まり）を、声が場面の中で終わるように直す。
- BGM：`public/sfx/bgm.ogg` を全体に小さく流す（`BGM_VOLUME`、最初と最後はフェード）。

## 素材の出典とライセンス

- `public/shots/`：DC-Designer v1.0.6 の実画面（2026-11-01、WSL の `npm run dev` を 1600×1000・2 倍で撮影）。画面右下のアカウント名は撮影時に「ユーザー」に置き換えた。
  - ポスターとスライドは、架空のイベント「みどり町 星空観察会」をブリーフにして、アプリから ChatGPT（レイアウト）と Codex（画像）で実際に生成したもの。写真に見える人物・夜空は AI が生成した画像で、実在の人・場所ではない。動画と静止画には「作例（架空のイベント）・写真の AI 生成は Windows 版 v1.0.6 では未対応」と出している（画像生成は main に入っているが、v1.0.6 には入っていないため。次の版を出したら文言を直す）。
  - ポスターは生成のあと、画面に出す前に手で 3 か所直した：書体（見出し Kaisei Tokumin・本文 Zen Kaku Gothic New）、「見つけよう、宇宙のふしぎ！」をピル型ラベルから吹き出しに、時間と会場の行の頭をそろえた。直す前のデータは控えてある（このリポジトリには入れていない）。スライドは生成したまま。
  - `layers/`：同じポスターを、API の応答だけを差し替えて下から 1〜22 枚のレイヤーで描画したもの（成果物は書き換えていない）。
- フォント（`public/fonts/`）：Mochiy Pop One、Noto Sans JP（どちらも SIL Open Font License 1.1。ライセンス文は同じフォルダ）。google/fonts リポジトリから取得。
- Remotion：個人・3 人以下の組織は無料。4 人以上の営利組織で使うときは会社ライセンスが要る（<https://www.remotion.dev/license>）。
- ナレーション（`public/vo/`）：VOICEVOX:春日部つむぎ（ノーマル、話速 0.9・抑揚 1.2）。規約は「VOICEVOX:春日部つむぎ」とクレジットを書けば商用・非商用で使える（エンジンの speaker_info と <https://tsumugi-official.studio.site/rule>、2026-11-01 確認）。動画の最後の場面の左下に「ナレーション：VOICEVOX:春日部つむぎ」と出している。
- BGM（`public/sfx/bgm.ogg`）：「Perspire (Loop) - Corporate-style background music with echo pedal guitar and piano」JapanYoshiTheGamer、CC0 1.0（<https://freesound.org/people/JapanYoshiTheGamer/sounds/713517/>、作品ページで確認）。Freesound の HQ プレビュー（MP3）の先頭 27 秒を切り出し、頭を 0.4 秒フェードして OGG にした。CC0 の候補 5 つから、BGM 用のループ曲で音量の上下が小さい（LRA 2.7）ものを選んだ（見送り：561190 Tropicorp Advertisement、830500 A Ukulele Tune（22 秒で足りない）、190478・562423）。
- 効果音（`public/sfx/`）：すべて Freesound / Kenney の CC0 1.0。作品ページでライセンスを確認した（2026-11-01）。
  | ファイル | 元の音 | 作者 | 出典 | 加工 |
  |---|---|---|---|---|
  | typing.ogg | Typing on a iMac keyboard | Guran89 | <https://freesound.org/people/Guran89/sounds/459370/> | 9.5 秒から 2.9 秒を切り出し、120Hz 以下を削り +4dB、前後をフェード |
  | click.ogg | Classic Click | adh.dreaming | <https://freesound.org/people/adh.dreaming/sounds/671105/> | — |
  | pop.ogg | POP SFX Neutral | ethernel0 | <https://freesound.org/people/ethernel0/sounds/776016/> | — |
  | whoosh.ogg | Whoosh | qubodup | <https://freesound.org/people/qubodup/sounds/60013/> | — |
  | tick.ogg | Click / Tick | Squirrel_404 | <https://freesound.org/people/Squirrel_404/sounds/683048/> | — |
  | riser.ogg | Cinematic Riser #3 subtle | BeaconStudio | <https://freesound.org/people/BeaconStudio/sounds/859482/> | — |
  | ding.ogg | Soft-Notifications - Bell - Ding-Dong.mp3 | LegitCheese | <https://freesound.org/people/LegitCheese/sounds/571513/> | — |
  | confirm.ogg | interface confirmation 001 | Kenney | <https://kenney.nl/assets/interface-sounds> | — |

  タイピング音以外は [Barty-Bart/motion-graphics](https://github.com/Barty-Bart/motion-graphics/tree/main/skills/sound-effects)（MIT、効果音は CC0）が先頭の無音を切り、ピークを -3dBFS にそろえて OGG にしたものを使った。タイピング音の候補は Freesound の CC0 から 4 つ比べ、打鍵の細かさ（1 秒に 7 回）と背景の雑音の少なさ（ピークとの差 38dB）で選んだ（見送り：537473・572167・844627、打鍵がまばら）。

## 確認したこと（2026-11-01）

- `ffprobe`：1920×1080・30fps・27.0 秒。MP4 は `yuv420p`（通常の色の範囲）・AAC・faststart、WebM は VP9・Opus。
- 音量（`ebur128`）：MP4 / WebM とも -16.0 LUFS、True Peak -2.9 / -2.5 dB（目標 -16 LUFS・-2 dB 以下）。`silencedetect`（2 秒以上の無音）：該当なし。BGM は声の間だけ半分に下げている（`BGM_DUCKED`）。
- 聞き取り：完成した MP4 を faster-whisper（large-v3-turbo）で文字起こしし、台本と 100% 一致（「DC Designer」も正しく聞き取られた）。最後の場面で効果音が「ディー・シー」に重なっていたときは「EC デザイナー」と聞き取られたので、効果音を声より前に済ませる順にした。
- 容量：MP4 約 6.6MB、WebM 約 4.9MB（上限 8MB）。サイトで配る大きさは、ポスター画像 WebP 約 105KB、ヒーロー AVIF 約 48KB / WebP 約 86KB。
- `freezedetect`（2 秒以上止まる所）と `blackdetect`（黒いコマ）：該当なし。
- 場面ごとのコマを書き出して目で確認（はみ出し・重なり・文字の読みやすさ）。
- `site/` で `npm run check`・`npm run build`・`npm test`・`npm run test:dist` が通ること。ビルドしたページで、動画の枠に WebP のポスター画像と WebM / MP4 の 2 つの source が出ること、ヒーロー画像が出ること（360px 幅も）。

確かめていないこと：実機のブラウザ（Windows の Chrome / Edge、iPhone の Safari）での再生。
