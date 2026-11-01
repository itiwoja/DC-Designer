# SITE-ADR-004：閲覧数の解析は入れない（Cloudflare Web Analytics 案を取り消し）
- 状態：取り消し（2026-11-01 ユーザー決定で解析を入れない） ／ 日付：2026-11-01（初版）、更新：2026-11-01（v0.2） ／ 決定者：ユーザー（SITE-Q-03 → SITE-D-27）
- 影響する ID：SITE-REQ-007, SITE-US-008, SITE-UC-007, SITE-FR-010, SITE-API-003（いずれも取り下げ）, SITE-NFR-005, SITE-NFR-006, SITE-NFR-015

## 状況
ヒアリングでユーザーは「Cookie なしの解析を入れる」を選び（SITE-D-09）、初版（v0.1）では Cloudflare Web Analytics のビーコンを使うと決めていた。トークンを用意するかを SITE-Q-03 で尋ねたところ、2026-11-01 にユーザーが「解析は入れない」と決めた。

## 決定
解析は入れない。解析そのものをスコープから外し、ページに解析のスクリプトを出さない。Cloudflare のアカウント・トークン・CSP の外部の宛先もいらない。ダウンロード数は GitHub Releases の asset の `download_count` で見る（[01 KPI](../01_requirements.md#2-目的成功指標kpi)）。

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| Cloudflare Web Analytics（v0.1 の決定） | Cookie なし・無料・Pages でも使える | アカウントとトークンが要る。閲覧の情報が Cloudflare に送られる | ユーザーが解析を入れないと決めた（2026-11-01） |
| GoatCounter | Cookie なし・OSS・軽い | 無料枠は非商用の条件 | 同上 |
| Umami（自前） | 完全に自分のデータ | サーバーと DB の運用が要る | 費用 0・運用最小に反する |

## 影響
- SITE-REQ-007・SITE-US-008・SITE-UC-007・SITE-FR-010・SITE-API-003 は取り下げて欠番にする（振り直さない）。
- 「トップ → ダウンロードへの遷移率」は測らない（測定手段なし）。
- 外部のスクリプトが無くなり、CSP は `script-src 'self'`・`connect-src 'self'` にできる（SITE-NFR-005・006）。
- プライバシーページには「サイトは Cookie を使わず、解析もしない」と書く（SITE-FR-007）。Cookie 同意バナーは不要。
