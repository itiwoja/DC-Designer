# SITE-ADR-002：GitHub Pages で配信する
- 状態：承認 ／ 日付：2026-11-01 ／ 決定者：ユーザー
- 影響する ID：SITE-REQ-004, SITE-FR-009, SITE-NFR-006, SITE-NFR-015, SITE-NFR-016

## 状況
費用 0 円で公開したい。ヒアリングでは一度 Cloudflare Workers が挙がったが、ドメインに github.io を使う希望があり、github.io は GitHub Pages でしか使えない。

## 決定
GitHub Actions から GitHub Pages に公開する。URL は `https://itiwoja.github.io/DC-Designer/`。

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| Cloudflare Workers（静的アセット） | 応答ヘッダーを設定できる・速い | アカウントとトークンの管理が増える。URL は workers.dev | ユーザーが github.io を選んだ |
| Cloudflare Pages | 同上 | 新機能は Workers 側 | 同上 |
| Vercel | 無料枠あり | 外部サービスが増える | 利点が少ない |

## 影響
- 応答ヘッダーを設定できないので、CSP は `<meta>` で入れる（SITE-NFR-006）。
- Astro の `base` が `/DC-Designer` になる。独自ドメインにすると全リンクが変わる。
