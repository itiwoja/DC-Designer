# SITE-ADR-005：ポリシーは docs/ の Markdown を正本としてビルド時に読み込む
- 状態：承認 ／ 日付：2026-11-01、更新：2026-11-01（v0.2 で承認） ／ 決定者：ユーザー（SITE-Q-04 案 A → SITE-D-28。案は Claude が出した）
- 影響する ID：SITE-REQ-006, SITE-FR-007, SITE-TBL-005

## 状況
コード署名ポリシーはすでに `docs/code-signing-policy.md` にあり、SignPath の審査ではサイトにも載せる必要がある。同じ文書を 2 か所に持つと食い違う。

## 決定
`docs/code-signing-policy.md` と、新設する `docs/privacy.md` を正本にし、サイトはビルド時に読み込むだけにする。相対リンクは GitHub の URL に書き換える。

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| `site/` に複製して書く | サイト向けに書ける | 正本が 2 つになり食い違う | 一貫性を失う |
| サイトから GitHub のファイルへリンクだけ | 実装が無い | サイトに載っていない扱いになる | SignPath の条件に合わない |

## 影響
- 正本の古い文面がそのまま公開される（SITE-R-01）。正本を直してから公開する。
- `docs/privacy.md` と `docs/code-signing-policy.md` の変更でサイトが再ビルドされる（SITE-FR-009）。
