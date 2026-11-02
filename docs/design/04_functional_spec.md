# 04. 機能仕様
- プロジェクト：DC-Designer 紹介サイト ／ 版数：v0.4（2026-11-01） ／ インプット：[03_use_cases](03_use_cases.md)

> **3行で**
> 1. 機能は 10 件（SITE-FR-010 解析ビーコンは取り下げ）。閲覧時に動くのはコピーボタンだけで、ほかはすべて**ビルド時に HTML を生成**する。
> 2. 版情報は GitHub API から取り、最新の**安定版**（draft・prerelease 以外）だけをダウンロード対象にする。
> 3. 署名の有無はリリースノートの決まった文言と、署名を始めた版（`signedSince`）で判定し、迷ったら「未署名」と出す（SITE-D-25・29）。

## 🧭 判断してほしいこと
| # | 種類 | 論点 | 選択肢 | おすすめ（理由） | 決まらないと止まるもの |
|---|---|---|---|---|---|
| SITE-Q-01 | 決定（2026-11-01） | 版が署名済みかどうかをサイトがどう知るか | A: リリースノートの文言を検出 / B: 配信 CI が JSON を追加 / C: 手で書く | **A に決定（ユーザー、SITE-D-25）**：「この版はコード署名をしていません」の有無で判定。CI の文言を変えたらサイトも直す | — |
| SITE-Q-04 | 決定（2026-11-01） | ポリシーの正本を `docs/` に置いてサイトは読むだけにするか | A: docs/ を正本に読み込む / B: site/ に別に書く | **A に決定（ユーザー、SITE-D-28）**：`docs/privacy.md` を新設し、サイトは読み込むだけ | — |
| SITE-R-02 | リスク | 未署名のため SmartScreen の警告で離脱する | — | 進め方と SHA-256 の確かめ方を、ボタンの直下に出す（SITE-FR-005） | — |

## 全体図
```mermaid
flowchart TB
  subgraph ビルド時
    F8[SITE-FR-008 リリース情報取得] --> F4[SITE-FR-004 DLページ]
    F8 --> F5[SITE-FR-005 SHA-256と確認手順]
    F8 --> F6[SITE-FR-006 更新履歴]
    F8 --> F1[SITE-FR-001 ヒーロー]
    F7[SITE-FR-007 ポリシー読込] 
    F2[SITE-FR-002 機能紹介] 
    F3[SITE-FR-003 動作要件]
    F11[SITE-FR-011 共通枠・SEO・404]
  end
  F9[SITE-FR-009 自動デプロイ] --> ビルド時
```
見てほしいところ：SITE-FR-008 が 4 つの機能の元データ。ここが失敗するとビルド全体を止める。閲覧時に外部へ送るものは無い（SITE-FR-010 解析ビーコンは取り下げ）。

## 要点
- 機能一覧と優先度は [機能一覧](#機能一覧)。10 件すべて Must（SITE-FR-010 は取り下げて欠番）。
- 安定版の選び方・SHA-256 の取り方・失敗時の扱いは [SITE-FR-008](#site-fr-008)。
- リリースノートは外部の PR タイトルを含むので、**HTML を無害化して表示**する（[SITE-FR-006](#site-fr-006)）。
- ポリシーは `docs/` の Markdown を正本として読み込み、リポジトリ内のリンクを GitHub の URL に書き換える（[SITE-FR-007](#site-fr-007)）。
- 素材が無い媒体の枠は、ビルドを止めずに「仮」と分かる仮の画像で出す。素材が揃う前でも公開する（[SITE-FR-002](#site-fr-002)、SITE-D-26）。

---

## 詳細

### 機能一覧
| ID | 機能名 | 概要 | 関連UC | 優先度 |
|---|---|---|---|---|
| SITE-FR-001 | ヒーロー | キャッチ・最新版のボタン・ヒーロー画像 | UC-001 | Must |
| SITE-FR-002 | 機能紹介 | 機能カード（見出し・説明・画像/動画）とデモ動画 | UC-001 | Must |
| SITE-FR-003 | 動作要件 | OS・AI の利用条件の表示 | UC-001, 002 | Must |
| SITE-FR-004 | ダウンロード | 最新安定版の exe へのリンクと版情報 | UC-002 | Must |
| SITE-FR-005 | 確認手順 | SHA-256・照合コマンド・SmartScreen の説明 | UC-002 | Must |
| SITE-FR-006 | 更新履歴 | 公開版のリリースノート（直近 100 件まで） | UC-003 | Must |
| SITE-FR-007 | ポリシー | プライバシー・コード署名ポリシー | UC-004 | Must |
| SITE-FR-008 | リリース情報取得 | ビルド時に GitHub API から取得・検証 | UC-005, 006 | Must |
| SITE-FR-009 | 自動デプロイ | main の変更・配信 CI の完了で公開 | UC-005, 006 | Must |
| SITE-FR-010 | ~~解析ビーコン~~ | 取り下げ（2026-11-01 ユーザー決定、SITE-D-27）。解析は入れない | ~~UC-007~~ | — |
| SITE-FR-011 | 共通枠・SEO・404 | ヘッダー・フッター・OGP・404 | UC-001 | Must |

### <a id="site-fr-001"></a>SITE-FR-001：ヒーロー 〔SITE-UC-001〕
- 入力：最新安定版（SITE-TBL-001）、ヒーロー媒体（SITE-TBL-004 の `hero`。`placeholder` の間は仮の画像）、キャッチ（SITE-TBL-007 の `home`）
- 処理：ボタンの文言は「Windows 版をダウンロード（v{version}）」、リンク先は exe の `browserDownloadUrl`。下に「無料・MIT ライセンス／Windows 10・11（x64）」を小さく出す
- 出力：SCR-001 の 1 画面目

### <a id="site-fr-002"></a>SITE-FR-002：機能紹介 〔SITE-UC-001〕
- 入力：機能（SITE-TBL-003）を `order` 順に、各機能の媒体（SITE-TBL-004）、デモ動画（SITE-TBL-004 の `demo`。機能カードの下に 1 本）
- 処理：`exeAvailable: false` の機能は出さない。`exeNote` があればカードに注記として出す（SITE-D-33）。媒体の `status` が `ready` なら画像/動画、`placeholder` なら枠の寸法に合わせた共通の仮の画像（「画面は準備中」と入った、実際の画面と誤解されない画像。[06 媒体の枠](06_ux_design.md#媒体の枠)）を出す（ビルドは止めない）。素材が揃う前でも公開してよい（SITE-D-26）。動画は `loop` `playsinline`（ナレーション・BGM・効果音が入っているので `muted` は付けない。2026-11-01、ユーザーの依頼。ナレーションの字幕を `track` で付ける）、`prefers-reduced-motion` のときは自動再生せずポスター画像を出す
- 機能（`exeAvailable: true`）：2026-11-01 から 2 つに絞った。ポスター作成（AI の下書き・白紙・PDF から作り、PDF・PNG で書き出し）／スライド作成（PowerPoint の読み込み・編集、アニメーション・台本・発表者ビュー、PPTX で書き出し）。Instagram 投稿はアプリから外した
- 注記（`exeNote`）：「ポスター作成」に「AI の下書きと写真・イラストの生成には、ChatGPT Plus / Pro のサインインが必要です」（2026-11-02、画像生成を Windows 版で使えるようにしたのに合わせて直した）

### <a id="site-fr-003"></a>SITE-FR-003：動作要件 〔SITE-UC-001, SITE-UC-002〕
| 項目 | 表示する内容 |
|---|---|
| OS | Windows 10 / 11（x64）。確認した版だけを書く（EXE-Q-03） |
| AI でレイアウト生成・修正 | ChatGPT Plus / Pro などでサインイン。**ChatGPT 無料プランは非対応**。Windows 版では OpenRouter は使えない（`server/ai.ts`） |
| 画像生成 | ChatGPT でサインインすると Codex CLI を自動で準備し、ChatGPT プランの枠で生成する（ブラウザでのサインインがもう一度ある。EXE-D-15）。Gemini の API キー・この PC の ComfyUI でも生成できる。OpenAI の API キーは使わない。どれも使わないときはダミー画像になる（`docs/changes/2026-11-01-desktop-imagegen.md`・`2026-11-02-signin-codex.md`） |
| サインイン不要で使えるもの | 白紙からの手動編集・保存・書き出し |

正本は SITE-TBL-007 の `requirements`。README と食い違ったら README（アプリ側）に合わせる。ただし README は開発版（`npm run dev`）の説明も含むので、Windows 版で使えるものだけを書く（製品版は `DC_DESIGNER_DESKTOP=1` で AI を ChatGPT プランに固定している。外への通信は、worker が `server/egress.ts` の許可表、画面が `desktop/appProtocol.ts` での遮断、更新確認が main プロセスの electron-updater〔GitHub Releases〕に分かれる）。

### <a id="site-fr-004"></a>SITE-FR-004：ダウンロード 〔SITE-UC-002〕
- 入力：最新安定版（SITE-TBL-001）、exe の資産（SITE-TBL-002 `kind: installer`）
- 出力：版・公開日（`YYYY年M月D日`、JST）・サイズ（MB、小数 1 桁。Windows のエクスプローラーと同じく 1 MB = 1,048,576 バイト）・署名状況・ダウンロードボタン・「すべての版（GitHub Releases）」へのリンク
- 署名状況：`signed` が `false` なら「⚠ この版はコード署名をしていません」、`true` なら「SignPath Foundation の署名つき」。判定は次の 2 つを両方満たすときだけ `true`、それ以外は `false`（迷ったら「未署名」と出す。SITE-D-25・29）
  1. リリースノートの `body` に「この版はコード署名をしていません」（SITE-TBL-006 の `unsignedMarker`）が無い
  2. 版が SITE-TBL-006 の `signedSince` 以上（`signedSince` が未設定なら満たさない）
- 配信 CI のこの文言を変えるときは `unsignedMarker` も直す。署名つきの最初の版を出すときは `signedSince` を書く（SITE-R-05）。書き忘れても「署名つき」と誤って出ることはない

### <a id="site-fr-005"></a>SITE-FR-005：SHA-256 と確認手順 〔SITE-UC-002〕
- 出力：SHA-256（64 桁の小文字 16 進数、コピーボタンつき）と、照合のコマンド
  ```powershell
  Get-FileHash "$env:USERPROFILE\Downloads\DC-Designer-Setup-1.0.6.exe" -Algorithm SHA256
  ```
- 「ダウンロード」フォルダーに保存した前提のコマンドなので、「保存先を変えた場合は、パスを直してください」と添える
- 照合の注意：`Get-FileHash` は大文字で表示するので、「大文字・小文字は区別せずに見比べてください」と添える
- 未署名のとき：SmartScreen の画面で「詳細情報」→「実行」と進める手順を、画像なしの番号付きリストで出す
- 値が合わないとき：「実行しないで、GitHub Issues か SECURITY.md の窓口に知らせてください」
- コピーボタンは閲覧時の小さなスクリプト（Clipboard API）。使えない環境では値を選択できる文字として出すだけ

### <a id="site-fr-006"></a>SITE-FR-006：更新履歴 〔SITE-UC-003〕
- 入力：draft 以外の Release（SITE-API-001 で取れる直近 100 件まで。prerelease は「プレリリース」の札を付けて含める。100 件を超えたら古い方を捨てる。SITE-TBL-001 と同じ上限で、当面は届かない）
- 処理：`body`（Markdown）を HTML に変換し、**生の HTML は捨てる**（許可するのは見出し・段落・リスト・リンク・強調・コード・引用だけ）。リンクは `https:` だけ残す。直近 10 版を開いた状態、それより古い版は `<details>` で畳む
- 出力：版ごとに見出し（`v1.0.6`、アンカー `#v1-0-6`）・公開日・本文・GitHub の Release へのリンク

### <a id="site-fr-007"></a>SITE-FR-007：ポリシー 〔SITE-UC-004〕
- 入力：`docs/privacy.md`・`docs/code-signing-policy.md`（SITE-TBL-005）
- 処理：Markdown を HTML にする。相対リンク（`./release-policy.md`、`../SECURITY.md` など）は `https://github.com/itiwoja/DC-Designer/blob/main/<path>` に書き換える。ただしサイトのページになっている文書（2 件）へのリンクはサイト内のページへ
- `docs/privacy.md` に書くこと：Windows 版のアプリが送る先（AI 利用時の ChatGPT プラン〔OpenAI の `auth.openai.com`・`api.openai.com`〕、フォント取得の Google Fonts、更新確認の GitHub Releases。worker の許可表 `server/egress.ts`〔AI・フォント〕と、main プロセスの electron-updater〔更新確認。起動のたびに自動で行う〕の両方に合わせる。画像生成〔Gemini・Codex CLI・ComfyUI〕と Codex CLI の取得〔GitHub〕も書く。OpenRouter は Windows 版では使わないので書かない）と、**AI の操作は追加の確認なしで送信する**こと（今の動き、SITE-D-12）。サイト自体は Cookie を使わず、所有者は解析もしない（閲覧数を数えない）こと（SITE-D-27）。ただし、サイトの配信（GitHub Pages）と exe のダウンロード（GitHub Releases）では、GitHub が閲覧者の IP アドレスなどを GitHub のプライバシー方針に従って記録すること（「何も記録されない」とは書かない）
- 署名ポリシーの古い文面（SITE-R-01）は PR #44 で解消した。`docs/code-signing-policy.md` のプライバシー節は、SignPath 向けの英文の要約と `docs/privacy.md` へのリンクだけにし、プライバシーの正本を 1 つにする（SITE-D-30）

### <a id="site-fr-008"></a>SITE-FR-008：リリース情報取得 〔SITE-UC-005, SITE-UC-006〕
- 処理：
  1. SITE-API-001 で Release を最大 100 件取得（`GITHUB_TOKEN` で認証）
  2. `draft: true` を捨てる。`prerelease: false` のうち `publishedAt` が最新のものを「最新安定版」にする
  3. 最新安定版の資産から `DC-Designer-Setup-<version>.exe`（installer）と `SHA256SUMS.txt`（checksums）を探す。`latest.yml` は使わない
  4. SITE-API-002 で `SHA256SUMS.txt` を取得し、exe のファイル名の行から値を取る（行の形は [SITE-API-002](09_api.md#site-api-002sha256sumstxt-の取得)。実物は `<64桁> *<ファイル名>`）
  5. 署名状況を判定する（リリースノートの文言の有無と `signedSince`、SITE-D-25・29）
  6. 改ざん・取り違えの検査（SITE-D-32）：exe と `SHA256SUMS.txt` の `browserDownloadUrl` が `https://github.com/itiwoja/DC-Designer/releases/download/v{version}/` で始まること、`SHA256SUMS.txt` の値とリリースノートの `SHA-256: \`<64桁>\`` 行の値が一致することを確かめる
- エラー（すべてビルド失敗。公開中のサイトは残る）：

| 条件 | ビルドのメッセージ |
|---|---|
| API が 2xx 以外・通信失敗（再試行は 5xx と通信失敗だけ 3 回まで。403・429 などの 4xx はすぐ失敗。[SITE-API-001](09_api.md#site-api-001)） | `GitHub API の取得に失敗しました（HTTP {status}）` |
| 安定版が 0 件 | `公開済みの安定版がありません` |
| ダウンロード URL が想定の接頭辞で始まらない | `ダウンロード先が想定と違います（{url}）` |
| リリースノートに `SHA-256:` 行が無い、または `SHA256SUMS.txt` の値と違う | `SHA-256 がリリースノートと一致しません` |
| exe か SHA256SUMS.txt が無い | `v{version} に {name} がありません` |
| SHA256SUMS.txt に exe の行が無い・64 桁の 16 進数でない | `v{version} の SHA-256 を読めません` |

### <a id="site-fr-009"></a>SITE-FR-009：自動デプロイ 〔SITE-UC-005, SITE-UC-006〕
| きっかけ | 条件 |
|---|---|
| `push`（main） | `site/**`・`docs/privacy.md`・`docs/code-signing-policy.md`・`.github/workflows/site.yml` のいずれかが変わった |
| `workflow_run` | `release-windows` が completed かつ結論が `success` |
| `workflow_dispatch` | 所有者が手で実行 |

同時に走ったら後のものだけ残す（`concurrency: pages`、実行中は取り消さない）。詳細は [07](07_architecture.md#デプロイ構成)。

### <a id="site-fr-010"></a>SITE-FR-010：解析ビーコン 〔SITE-UC-007〕 取り下げ（2026-11-01 ユーザー決定、SITE-D-27）
- 解析は入れないことにしたため取り下げ。ページに解析のスクリプトを出さない。ID は欠番にして振り直さない

### <a id="site-fr-011"></a>SITE-FR-011：共通枠・SEO・404 〔SITE-UC-001〕
- ヘッダー：ロゴ・「機能」「ダウンロード」「更新履歴」・GitHub へのリンク。フッター：プライバシー・コード署名ポリシー・SECURITY・MIT ライセンス・GitHub Issues
- 各ページに `title`・`description`・OGP（`og:image` は 1200×630 の `ogp` 媒体（2026-11-02 から `ready`）。`placeholder` の間はアプリのアイコン）・`canonical`・`sitemap.xml`
- 404 はトップとダウンロードへのリンクだけ

### 権限マトリクス
| 機能 | 閲覧者 | 所有者 |
|---|---|---|
| 全ページの閲覧 | ○ | ○ |
| サイトの更新（push・手動実行） | × | ○（GitHub の権限で制御） |

### ステータス定義
| 対象 | 値 | 意味 |
|---|---|---|
| 媒体（SITE-TBL-004 `status`） | `placeholder` / `ready` | 素材なし（仮の画像を出す） / 素材あり。`placeholder` → `ready` の一方向 |
| Release | `draft` / `prerelease` / 安定版 | GitHub の値をそのまま使う。サイトでは変えない |

## このドキュメントで決まったこと
- SITE-D-12：プライバシーは今の動き（AI 送信は追加確認なし）に合わせる（決定者：ユーザー）
- SITE-D-15：更新履歴は直近 10 版を開き、古い版は畳む（Claude判断（おまかせ））
- SITE-D-16：リリースノートの生 HTML は捨てる（定石・安全のため）
- SITE-D-25：署名の有無はリリースノートの文言で判定（決定者：ユーザー、2026-11-01）
- SITE-D-26：素材が揃う前は仮の画像で公開（決定者：ユーザー、2026-11-01）
- SITE-D-27：解析は入れない。SITE-FR-010 を取り下げ（決定者：ユーザー、2026-11-01）
- SITE-D-28：ポリシーは `docs/` が正本（決定者：ユーザー、2026-11-01）
- SITE-D-29：署名の判定は `signedSince` も見て安全側に倒す（決定者：ユーザー〔Claude の案を承認〕、2026-11-01）
- SITE-D-30：プライバシーの正本は `docs/privacy.md` の 1 つ（決定者：ユーザー〔Claude の案を承認〕、2026-11-01）
- v0.3：再試行の条件を SITE-API-001 とそろえ、デモ動画を SITE-FR-002 に含め、更新履歴の上限（100 件）を明記
