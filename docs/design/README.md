# DC-Designer 紹介サイト 設計書
> **3行で**：一般の Windows 利用者に DC-Designer を知ってもらい、安心してダウンロードしてもらう日本語の静的サイト ／ トップ・ダウンロード・更新履歴・ポリシーの 6 画面、版情報はリリースで自動更新、Astro＋GitHub Pages（`https://itiwoja.github.io/DC-Designer/`） ／ Web 版エディタ・英語版・使い方ガイド・アカウントは作らない

- 版数：v0.2（2026-11-01） ／ 状態：設計のみ（`site/` もワークフローもまだ無い）
- Windows 版の配布設計（`docs/README.md`）とは別の設計書。ID はすべて `SITE-` 付き。

## 🧭 判断してほしいこと（全ドキュメントから集約）
| # | 種類 | 論点 | おすすめ | 決まらないと止まるもの | 詳細 |
|---|---|---|---|---|---|
| SITE-R-01 | リスク | `docs/code-signing-policy.md` のプライバシー節が古い（AI 送信の確認窓は 2026-10-26 に撤去済み）。そのままサイトに載る | 公開前に正本を今の動きに直す（本設計の範囲外） | コード署名ポリシーの公開 | [11](11_tech_spec.md#12-リスクと対策) |
| SITE-R-02 | リスク | 未署名で SmartScreen の警告が出て離脱する | 進め方と SHA-256 の確かめ方をボタン直下に出す | — | [04](04_functional_spec.md) |
| SITE-R-03 | リスク | 機能紹介が exe 版と食い違う | 機能ごとに `exeAvailable` を持たせて出し分ける | — | [08](08_database.md) |
| SITE-R-04 | リスク | 配信 CI の名前を変えると自動連動が切れる | 名前を変えるときは `site.yml` も直す | — | [ADR-003](adr/SITE-ADR-003-release-trigger.md) |

### 決定済みの論点（2026-11-01、決定者：ユーザー）
| # | 論点 | 決定 | 決定事項 | 反映先 |
|---|---|---|---|---|
| SITE-Q-01 | 版が署名済みかをサイトがどう知るか | 案 A：リリースノートの「この版はコード署名をしていません」の有無で判定 | SITE-D-25 | [04](04_functional_spec.md#site-fr-004)、[08](08_database.md#site-tbl-001) |
| SITE-Q-02 | スクショ・動画が揃う前に公開するか | 案 B：「仮」と分かる仮の画像で先に公開し、Remotion の素材ができたら差し替える | SITE-D-26 | [01](01_requirements.md)、[04](04_functional_spec.md#site-fr-002)、[06](06_ux_design.md#媒体の枠) |
| SITE-Q-03 | Cloudflare Web Analytics のトークンを用意するか | 解析は入れない（解析そのものをスコープから外す。REQ-007・US-008・UC-007・FR-010・API-003 は取り下げ） | SITE-D-27 | [ADR-004](adr/SITE-ADR-004-analytics.md)、[07](07_architecture.md) |
| SITE-Q-04 | ポリシーの正本を `docs/` に置き、サイトは読むだけにするか | 案 A：`docs/` を正本にし `docs/privacy.md` を新設。サイトは読み込むだけ | SITE-D-28 | [ADR-005](adr/SITE-ADR-005-policy-source.md) |

## 全体図（C4 レベル1：コンテキスト）
```mermaid
flowchart LR
  V([閲覧者]) -->|読む| S[紹介サイト<br>GitHub Pages]
  V -->|exe をダウンロード| GR[(GitHub Releases)]
  O([所有者]) -->|タグ・main へ push| GH[GitHub リポジトリ<br>site/ と docs/]
  GH -->|Actions でビルド・公開| S
  GH -.版情報.-> GR
```
見てほしいところ：サイトは exe を置かない。版情報はビルド時に GitHub から取る。解析は入れない（Cookie も使わない）。

## 読む順番
| 目的 | 読むもの | 所要 |
|---|---|---|
| 全体像だけ知りたい | この README → [11_tech_spec](11_tech_spec.md) の要約層 | 5 分 |
| 何を作るか判断したい | [01](01_requirements.md) → [06](06_ux_design.md) の要約層 | 10 分 |
| 実装する | [07](07_architecture.md) → [08](08_database.md) → [09](09_api.md) → [10](10_diagrams.md) → [04](04_functional_spec.md) | — |

## 主要な設計判断（ADR）
| ADR | 決定 | 状態 |
|---|---|---|
| [SITE-ADR-001](adr/SITE-ADR-001-astro.md) | Astro で静的に生成 | 承認 |
| [SITE-ADR-002](adr/SITE-ADR-002-github-pages.md) | GitHub Pages で配信（Cloudflare 案から変更） | 承認 |
| [SITE-ADR-003](adr/SITE-ADR-003-release-trigger.md) | リリース連動は `workflow_run`（`release: published` は GITHUB_TOKEN 起因で発火しない） | 承認 |
| [SITE-ADR-004](adr/SITE-ADR-004-analytics.md) | 解析は入れない（Cloudflare Web Analytics 案を取り消し） | 取り消し（2026-11-01） |
| [SITE-ADR-005](adr/SITE-ADR-005-policy-source.md) | ポリシーは `docs/` を正本に読み込む | 承認 |
| [SITE-ADR-006](adr/SITE-ADR-006-same-repo.md) | 同じリポジトリの `site/` | 承認 |

## 最近の変更
- 2026-11-01 v0.2 SITE-Q-01〜04 の決定を反映（署名は文言で判定／仮の画像で先に公開／解析は入れない／ポリシーは `docs/` が正本）。解析の ID（REQ-007・US-008・UC-007・FR-010・API-003）は欠番として取り下げ
- 2026-11-01 v0.1 初版
