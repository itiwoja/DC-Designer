# 11. 技術仕様書
- プロジェクト：DC-Designer 紹介サイト ／ 版数：v0.4（2026-11-01） ／ インプット：[01](01_requirements.md)〜[10](10_diagrams.md)

> **3行で**
> 1. Astro で作る日本語の静的 LP を、同じリポジトリの `site/` に置き、GitHub Actions で `https://itiwoja.github.io/DC-Designer/` に公開する。
> 2. 版情報・SHA-256・更新履歴はビルド時に GitHub API から取り、配信 CI（release-windows）の完了で自動で作り直す。
> 3. サーバー・DB・アカウント・Web 版エディタ・英語版は持たない。各節の詳細はリンク先を正本にする。

## 🧭 判断してほしいこと
| # | 種類 | 論点 | おすすめ | 詳細 |
|---|---|---|---|---|
| SITE-R-01 | リスク（解消済み） | `docs/code-signing-policy.md` のプライバシー節が古かった（確認窓は撤去済み、OpenRouter・Gemini も載っていた） | PR #44 で解消（`docs/privacy.md` を新設、SITE-D-30） | [12](#12-リスクと対策) |
| SITE-R-02 | リスク | 未署名で SmartScreen の警告が出て離脱する | 手順と SHA-256 をボタン直下に出す | [04](04_functional_spec.md) |
| SITE-R-03 | リスク | 機能紹介が exe 版と食い違う（exe では OpenRouter・OpenAI の API キーでの画像生成が無効など） | `exeAvailable` で出し分け、制限は `exeNote` でカードに出す。README の変更時に見直す | [08](08_database.md) |
| SITE-R-04 | リスク | 配信 CI の名前を変えると自動連動が切れる | 名前を変えるときは `site.yml` も直す | [12](#12-リスクと対策) |
| SITE-R-05 | リスク | 署名を始めるときに `signedSince` を書き忘れると、署名済みの版が「未署名」と出る | 署名つきの最初の版を出す手順に入れる | [12](#12-リスクと対策) |

決定済み（2026-11-01、決定者：ユーザー）：SITE-Q-01 → 署名は文言で判定（SITE-D-25）／SITE-Q-02 → 仮の画像で先に公開（SITE-D-26）／SITE-Q-03 → 解析は入れない（SITE-D-27）／SITE-Q-04 → ポリシーは `docs/` が正本（SITE-D-28）。一覧は [README](README.md#決定済みの論点2026-11-01決定者ユーザー)。

## 全体図
```mermaid
flowchart LR
  O([所有者]) -->|タグ| RW[release-windows] -->|workflow_run| SW[site.yml]
  O -->|main へ push| SW
  SW -->|API-001/002| GH[(GitHub API・Releases)]
  SW --> PG[GitHub Pages<br>SCR-001〜006]
  V([閲覧者]) --> PG
  V -->|API-004| GH
```
見てほしいところ：外とつながる線は 3 本だけ（API-001・002・004）。解析は入れない（API-003 は取り下げ）。

## 要点
- 技術スタックと ADR は [2](#2-システム全体像)、機能は [3](#3-機能概要)。
- 最重要の流れはリリース連動（[10](10_diagrams.md#site-uc-005リリース連動でサイトを更新する)）。
- セキュリティは「外へ出す物を減らす・外から来る文字を無害化・CI の権限を最小」（[8](#8-セキュリティ設計)）。

---

## 詳細

### 1. 概要
- 目的：一般利用者に「何ができるか」を伝え、Windows 版を安心してダウンロードしてもらう（[01](01_requirements.md)）。
- スコープ：紹介・ダウンロード・更新履歴・ポリシーの 6 画面。Won't は [01 §7](01_requirements.md#7-スコープ外wont)。
- 対象読者：サイトを実装・運用する人（所有者）。

### 2. システム全体像
C4 図は [07](07_architecture.md)。Astro（静的）・GitHub Pages・GitHub Actions（Node 24）。解析は入れない。判断は SITE-ADR-001〜006（004 は取り消し＝解析なし、005 は承認）。

### 3. 機能概要
10 機能（すべて Must。SITE-FR-010 解析ビーコンは取り下げ）。一覧は [04 機能一覧](04_functional_spec.md#機能一覧)。閲覧時に動くのはコピーボタンだけ。

### 4. データモデル
DB の代わりに 7 つの SITE-TBL（[08](08_database.md)）。Release・ReleaseAsset は毎回 API から取り、Feature・Media・Policy・PageText は Markdown / JSON に手で書く。

### 5. インターフェース
提供する API は無い。利用するのは SITE-API-001・002・004（[09](09_api.md)。003 は取り下げ）。

### 6. 画面構成
SITE-SCR-001〜006（[06](06_ux_design.md)）。どの画面からも 1 クリックでダウンロード。

### 7. 非機能要件への対応方針
| NFR | 実現手段 |
|---|---|
| SITE-NFR-001〜004 性能 | 静的生成・閲覧時の JS はコピーボタンの `<script>` 1 本だけ（島は使わない）・画像を AVIF/WebP に・動画は遅延読み込み |
| SITE-NFR-009・010 反映 | `workflow_run`・push の paths で必要なときだけビルド |
| SITE-NFR-012〜014 | セマンティックな HTML・コントラスト・360px から 1 列 |
| SITE-NFR-015 コスト | GitHub Pages の無料枠 |

### 8. セキュリティ設計
- 認証：閲覧者なし。CI は `GITHUB_TOKEN`（`contents: read`）と OIDC（`pages: write`・`id-token: write`）だけ。PAT なし（SITE-NFR-008、`docs/release-policy.md`）。
- 入力検証：リリースノートの生 HTML を捨てる・`https:` 以外のリンクを消す（SITE-NFR-007）。content collections はスキーマで検証。
- 配信の境界：`site/` はアプリと依存を共有せず、アプリの配布物の許可リストに入らない（SITE-D-18、既存 ADR-005）。
- 秘密情報：サイトに秘密は無い。
- 個人情報：Cookie・localStorage なし、解析もしない（SITE-D-27）。そのことと、配信元の GitHub は GitHub の方針でアクセスを記録することをプライバシーに書く（SITE-FR-007）。
- CSP は `<meta>` で（SITE-NFR-006）。インラインの CSS・JS と Web フォントを使わない（SITE-D-31）。
- 署名の表示は迷ったら「未署名」と出す（SITE-D-29）。

### 9. エラーハンドリング・ログ・監視
ビルド時の失敗はすべてビルドを止め、公開中のサイトを残す（[04 SITE-FR-008](04_functional_spec.md#site-fr-008)・[10 例外](10_diagrams.md#例外ビルド失敗)）。通知は Actions の失敗通知。公開後の監視は持たない。

### 10. 環境・設定
| 名前 | 種類 | 必須 | 説明 |
|---|---|---|---|
| GITHUB_TOKEN | Actions が自動で渡す | ○（CI） | SITE-API-001 の認証。手元では任意 |
| Pages の Source | リポジトリ設定 | ○ | 「GitHub Actions」 |
| signedSince | SiteConfig（`site/` のファイル） | —（初期は未設定） | 署名を始めた最初の版。未設定なら全版「未署名」（SITE-D-29） |

環境は本番だけ。手元では `site/` で `npm run dev`。

### 11. テスト方針
| レベル | 観点 |
|---|---|
| 単体 | 安定版の選び方（draft・prerelease の除外）、SHA256SUMS の解析（`*` 付き・空白 2 つの両方、不一致・形式不正）、署名判定（未署名の文言あり・なし × `signedSince` 未設定・より前・以上）、リンクの書き換え、無害化（`<script>`・`javascript:` が消える） |
| ビルド | 媒体 `ready` でファイルが無いと失敗、`placeholder` は仮の画像で通る、content のスキーマ違反で失敗、出力の HTML に `src` の無い `<script>`（`type` を問わない）・`<style>`・`style=` が無い（SITE-D-31）、ダウンロード URL の接頭辞とリリースノートの SHA-256 の照合（SITE-D-32） |
| 表示 | 6 画面を 360px・1280px で撮って確認、Lighthouse・axe（SITE-NFR-001・012） |
| 連動 | `workflow_dispatch` で版情報が最新の Release と一致すること、ポリシーの最終更新日がそのファイルの最終コミット日と一致すること |

### 12. リスクと対策
| # | リスク | 対策 |
|---|---|---|
| SITE-R-01（解消済み） | 署名ポリシーの正本のプライバシー節が「本人が確認した内容を送る」のままで、Windows 版で使わない OpenRouter・Gemini も載っていた | PR #44 で解消。`docs/privacy.md` を正本にし、署名ポリシーは SignPath 向けの英文の要約とリンクだけにした（SITE-D-30）。SITE-ADR-005（承認）によりサイトは正本を読むだけ |
| SITE-R-02 | 未署名で SmartScreen の警告 | SITE-FR-005 |
| SITE-R-03 | 機能紹介と exe の差 | SITE-TBL-003 の `exeAvailable`・`exeNote`。デモ動画も exe 版の範囲で撮る |
| SITE-R-04 | 配信 CI の名前（`release-windows`）を変えると連動が切れる | ワークフロー名を変えるときは `site.yml` も直す取り決め（SITE-ADR-003） |
| SITE-R-05 | 署名を始めるときに `signedSince` を書き忘れると、署名済みの版が「未署名」と出る（逆に「署名つき」と誤ることはない） | 署名つきの最初の版を出す手順に「`signedSince` を書く」を入れる（SITE-D-29） |

### 13. 未決事項・Claude判断（おまかせ）で決めた項目
- 未決：なし。SITE-Q-01〜04 は 2026-11-01 にユーザーが決定（SITE-D-25〜28）。SITE-ADR-005 は承認、SITE-ADR-004 は取り消し（解析は入れない）。v0.3 の見直しで SITE-D-29〜31 を追加。
- おまかせ（数値だけ）：SITE-D-13（数値目標）、15（更新履歴の畳み方）、17（媒体の寸法）、22（再試行）。一覧は [00 決定事項ログ](00_overview.md#決定事項ログ)。

### 14. 参照ドキュメント
- 本設計：[README](README.md)、[00](00_overview.md)〜[10](10_diagrams.md)、[adr/](adr/)
- 既存：[配布・更新ポリシー](../release-policy.md)、[Code signing policy](../code-signing-policy.md)、[Windows 版の配布設計](../README.md)、[AI 送信確認の撤去](../changes/2026-10-26-desktop-ai-direct-send.md)
