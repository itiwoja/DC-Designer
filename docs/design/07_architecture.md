# 07. システムアーキテクチャ
- プロジェクト：DC-Designer 紹介サイト ／ 版数：v0.1（2026-11-01） ／ インプット：[04](04_functional_spec.md)、[05](05_non_functional.md)

> **3行で**
> 1. Astro で静的に生成し、GitHub Actions から GitHub Pages へ公開する。サーバーも DB も持たない。
> 2. リリースとの連動は、配信 CI（release-windows）の完了を `workflow_run` で受ける。配信 CI そのものは変えない。
> 3. 閲覧時に外部へ出るのは、Cloudflare Web Analytics のビーコンと、GitHub Releases からのダウンロードだけ。

## 🧭 判断してほしいこと
| # | 種類 | 論点 | 選択肢 | おすすめ（理由） | 決まらないと止まるもの |
|---|---|---|---|---|---|
| SITE-Q-03 | 未決 | Cloudflare のアカウントを作り、Web Analytics にサイトを登録してトークンをリポジトリ変数に入れるか | A: 入れる / B: 当面入れない | A（解析はユーザー選択。未設定でもビーコンを出さずに公開できるので、公開は止まらない） | SITE-FR-010 だけ |
| SITE-Q-04 | トレードオフ | ポリシーの正本を `docs/` に置いてサイトは読むだけにするか（`docs/privacy.md` を新設してよいか） | A: docs/ を正本に読み込む / B: site/ に別に書く | A（正本が 1 つで食い違わない。SignPath の条件も満たす） | SITE-FR-007、SITE-TBL-005 |

## 全体図
C4 レベル 1：コンテキスト
```mermaid
flowchart LR
  V([閲覧者]) -->|HTTPS| S[DC-Designer 紹介サイト<br>GitHub Pages]
  V -->|exe をダウンロード| GR[(GitHub Releases)]
  S -.ビーコン.-> CWA[(Cloudflare Web Analytics)]
  O([所有者]) -->|push・タグ| GH[GitHub リポジトリ]
  GH -->|Actions でビルド・公開| S
  GH -.API でリリース情報.-> GR
```
見てほしいところ：サイトは exe を置かない。ダウンロードは常に GitHub Releases から。

## 要点
- コンテナは「サイトのソース」「サイトのワークフロー」「GitHub Pages」の 3 つ（[レベル 2](#レベル2コンテナ図)）。
- 技術の選定と代替案は ADR へ（[技術スタック](#技術スタック)）。
- 公開の URL は `https://itiwoja.github.io/DC-Designer/`。Astro の `site` と `base` で固定（[環境](#デプロイ構成)）。
- 独自ドメインに変えると `base` が `/` に変わり、全リンクが変わる（Won't だが、変えるときの影響として記録）。

---

## 詳細

### レベル2：コンテナ図
```mermaid
flowchart LR
  subgraph REPO["リポジトリ itiwoja/DC-Designer"]
    SRC[site/ Astro のソース]
    DOCS[docs/privacy.md<br>docs/code-signing-policy.md]
    WF[.github/workflows/site.yml]
    RW[.github/workflows/release-windows.yml<br>既存・変更しない]
  end
  RW -->|workflow_run completed| WF
  WF -->|SITE-API-001/002| API[(GitHub REST API<br>Releases)]
  WF -->|build| ART[静的ファイル dist/]
  SRC --> WF
  DOCS --> WF
  ART -->|deploy-pages| PAGES[GitHub Pages<br>環境 github-pages]
  PAGES --> V([閲覧者])
```
見てほしいところ：release-windows とサイトのワークフローはファイルが別。権限も別（[SITE-ADR-003](adr/SITE-ADR-003-release-trigger.md)）。

### レベル3：コンポーネント図（site/）
```mermaid
flowchart TB
  CFG[astro.config site/base] --> PAGES
  LR[lib/releases.ts<br>SITE-FR-008 取得・検証] --> PAGES[pages/<br>index・download・changelog・privacy・code-signing・404]
  CC[content/<br>features・home・requirements・media] --> PAGES
  POL[lib/policies.ts<br>SITE-FR-007 docs読込・リンク書換] --> PAGES
  MD[lib/markdown.ts<br>無害化] --> LR
  MD --> POL
  PAGES --> LAY[layouts/Base<br>ヘッダー・フッター・CSP・ビーコン]
  ISL[components/CopyButton<br>唯一の島] --> PAGES
```

### 技術スタック
| レイヤー | 採用技術 | 理由 | 代替案 |
|---|---|---|---|
| サイト生成 | Astro（静的出力、導入時の最新安定版を固定） | JS をほぼ出さない・Markdown・ビルド時取得が素直 | 素の HTML、Vite+React → [SITE-ADR-001](adr/SITE-ADR-001-astro.md) |
| Markdown | Astro 標準の変換＋無害化（rehype-sanitize 相当） | リリースノートに外部の文字が入る | — |
| 画像 | `astro:assets`（AVIF/WebP をビルドで生成） | SITE-NFR-003 | — |
| ホスティング | GitHub Pages（Actions から公開） | 0 円・リポジトリと同じ場所 | Cloudflare Workers、Vercel → [SITE-ADR-002](adr/SITE-ADR-002-github-pages.md) |
| CI | GitHub Actions、Node 24（配信 CI と同じ） | 既存の CI と揃える | — |
| 解析 | Cloudflare Web Analytics | Cookie なし・無料・Pages でも使える | GoatCounter、Umami、なし → [SITE-ADR-004](adr/SITE-ADR-004-analytics.md) |
| 置き場所 | 同じリポジトリの `site/`（独自の `package.json`） | リリースと連動しやすい | 別リポジトリ → [SITE-ADR-006](adr/SITE-ADR-006-same-repo.md) |

`site/` はアプリの `package.json` と依存を共有しない（アプリの配布物検査の許可リストに入らないようにする。ADR-005 と整合）。

### デプロイ構成
| 項目 | 値 |
|---|---|
| 環境 | 本番だけ（GitHub Pages の環境 `github-pages`、デプロイできるブランチは `main` だけ、承認は不要） |
| URL | `https://itiwoja.github.io/DC-Designer/`（Astro：`site: "https://itiwoja.github.io"`、`base: "/DC-Designer"`） |
| 手元での確認 | `site/` で `npm run dev`。版情報の取得は `GITHUB_TOKEN` 無しでも動く（未認証は 60 回/時） |
| 所有者の初期設定 | リポジトリの Settings → Pages → Source を「GitHub Actions」にする |

ワークフローの仕様（抜粋。仕様として示すもので、このままの実装を求めるものではない）：
```yaml
on:
  push: { branches: [main], paths: ["site/**", "docs/privacy.md", "docs/code-signing-policy.md", ".github/workflows/site.yml"] }
  workflow_run: { workflows: ["release-windows"], types: [completed] }
  workflow_dispatch: {}
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: false }
# build ジョブは workflow_run のとき conclusion == 'success' だけ実行
```

### 認証・認可
- 閲覧者の認証は無い。
- ビルドは Actions の `GITHUB_TOKEN`（`contents: read`）で GitHub API を読む。Pages への公開は OIDC（`id-token: write`）。PAT は使わない。

### 外部連携
| 相手 | いつ | 何を | 失敗時 |
|---|---|---|---|
| GitHub REST API | ビルド時 | Release 一覧（SITE-API-001） | ビルド失敗 |
| GitHub Releases | ビルド時・閲覧時 | SHA256SUMS.txt（SITE-API-002）・exe（SITE-API-004） | ビルド失敗 ／ 閲覧者が再試行 |
| Cloudflare Web Analytics | 閲覧時 | ページの閲覧（SITE-API-003） | 計測が欠けるだけ |

### ログ・監視・エラー通知
- ビルドのログは Actions に残る（既定の保持期間）。失敗は GitHub の通知で所有者に届く。
- 公開後の監視は持たない（静的サイト、SITE-NFR-016）。

### 主要な設計判断（ADR）
| ADR | 決定 | 状態 |
|---|---|---|
| [SITE-ADR-001](adr/SITE-ADR-001-astro.md) | Astro で静的生成 | 承認 |
| [SITE-ADR-002](adr/SITE-ADR-002-github-pages.md) | GitHub Pages で配信 | 承認 |
| [SITE-ADR-003](adr/SITE-ADR-003-release-trigger.md) | リリース連動は `workflow_run` | 承認 |
| [SITE-ADR-004](adr/SITE-ADR-004-analytics.md) | Cloudflare Web Analytics | 承認 |
| [SITE-ADR-005](adr/SITE-ADR-005-policy-source.md) | ポリシーは docs/ を正本に読み込む | 提案（SITE-Q-04） |
| [SITE-ADR-006](adr/SITE-ADR-006-same-repo.md) | 同じリポジトリの site/ | 承認 |

## このドキュメントで決まったこと
- 上の ADR のうち 5 件（SITE-ADR-005 は提案のまま、SITE-Q-04）
- SITE-D-18：`site/` はアプリと依存を共有しない（定石・配布物の境界を守るため）
- SITE-D-19：Pages の環境に承認は付けない（定石。公開してよいかは main へのマージで判断済み）
