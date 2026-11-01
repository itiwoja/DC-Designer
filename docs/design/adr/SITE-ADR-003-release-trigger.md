# SITE-ADR-003：リリース連動は配信 CI の完了を workflow_run で受ける
- 状態：承認 ／ 日付：2026-11-01 ／ 決定者：ユーザー（自動再ビルド）＋ Claude判断（仕組みの選定）
- 影響する ID：SITE-REQ-004, SITE-UC-005, SITE-FR-009, SITE-NFR-008, SITE-NFR-009

## 状況
ユーザーは「リリース公開で自動再ビルド」を選んだ。しかし配信 CI は `gh release create` を `github.token` で実行しており、GITHUB_TOKEN が起こしたイベントでは新しいワークフローが起動しない（`workflow_dispatch`・`repository_dispatch` を除く）。`on: release: published` は発火しない（[GitHub Docs：Triggering a workflow from a workflow](https://docs.github.com/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow)）。

## 決定
サイトのワークフロー `site.yml` を `workflow_run`（`workflows: [release-windows]`、`types: [completed]`）で起動し、結論が `success` のときだけビルドする。配信 CI は変更しない。

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| `on: release: published` | 素直 | GITHUB_TOKEN 起因で発火しない | 動かない |
| release-windows に Pages 公開のジョブを追加 | 確実・即時 | 配信 CI に `pages: write` が入り、配信の境界が広がる | 配信 CI を変えたくない（release-policy） |
| publish の最後に `gh workflow run site.yml` | 例外として発火する | 配信 CI の変更と `actions: write` が要る | 同上 |
| PAT / GitHub App で Release を作る | イベントが発火する | `contents: write` 相当の資格情報が増える | release-policy.md が避けると定めている |

## 影響
- 配信 CI のワークフロー名 `release-windows` を変えると連動が切れる（SITE-R-04）。
- `workflow_run` は既定ブランチ（main）の `site.yml` で動くので、公開ブランチ main（SITE-D-10）と一致する。
