# SITE-ADR-004：閲覧数は Cloudflare Web Analytics で Cookie なしに数える
- 状態：承認 ／ 日付：2026-11-01 ／ 決定者：ユーザー（Cookie なしの解析）＋ Claude判断（サービスの選定）
- 影響する ID：SITE-REQ-007, SITE-FR-010, SITE-API-003, SITE-NFR-005, SITE-NFR-006

## 状況
ユーザーは「Cookie なしの解析を入れる」を選んだ。その時点では Cloudflare での配信も候補だったが、配信は GitHub Pages に決まった。

## 決定
Cloudflare Web Analytics のビーコン（手動の JS タグ）を使う。トークンが無いビルドではビーコンを出さない。

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| GoatCounter | Cookie なし・OSS・軽い | 無料枠は非商用の条件 | ユーザーが Cloudflare を挙げていた |
| Umami（自前） | 完全に自分のデータ | サーバーと DB の運用が要る | 費用 0・運用最小に反する |
| 解析なし | 最も単純・プライバシー最良 | 導線を直す材料が無い | ユーザーが解析を選んだ |

## 影響
- Cloudflare のアカウントが要る（SITE-Q-03）。
- プライバシーページに Cloudflare への送信を書く。Cookie 同意バナーは不要。
