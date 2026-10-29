# Code signing policy

DC-Designer の Windows 版インストーラー・更新ファイルのコード署名の方針。SignPath Foundation の[利用条件](https://signpath.org/terms)に沿って公開する。

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)

> 状態：未申請。タグ起点のビルド（`.github/workflows/release-windows.yml`）は 2026-10-29 に用意した。SignPath Foundation の審査が通り、シークレットを登録するまでは、未署名であることをリリースノートに明記して公開する（所有者の判断）。

## 署名するもの

- このリポジトリのソースから GitHub Actions でビルドした、DC-Designer の Windows 版インストーラー（NSIS）とその中の実行ファイルだけ。
- 上流の OSS（Electron など）が配っているバイナリは、このプロジェクトの名前では署名しない。
- ファイルのメタデータは、製品名 `DC-Designer`、会社名・説明・版数をビルドごとにそろえる。

## 署名までの流れ

1. `main` で検証したコミットを `release` へ進め、版のタグを付ける（[配布・更新ポリシー](./release-policy.md)）。
2. タグを起点に GitHub Actions が、許可リストで集めたファイルだけからビルドし、配布物を検査する（[ADR-005](./adr/ADR-005-release-artifact-boundary.md)）。
3. 署名要求は SignPath に送られ、**Approver が1件ずつ手動で承認**したものだけが署名される。
4. 署名後の配布物を再検査してから、公開 GitHub Releases に置く。

## 役割

| 役割 | 担当 |
| --- | --- |
| Committers and reviewers | [itiwoja](https://github.com/itiwoja)（リポジトリの所有者。外部からの Pull Request はすべてレビューしてから取り込む） |
| Approvers | [itiwoja](https://github.com/itiwoja) |

- 全員が GitHub と SignPath に多要素認証を使う。

## プライバシー

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

- AI 機能（OpenAI・ChatGPT / OpenRouter / Google Gemini）を使うときだけ、本人が送信先と対象を確認した内容をその AI サービスへ送る。画像は既定で送らない（[画像保護・フォント取得](./desktop-release-privacy.md)）。
- フォント取得では、作品の文字を送らず、フォントの識別情報だけを Google Fonts へ送る。
- 更新確認では、公開 GitHub Releases の公開情報だけを取得する。
- 送信先のプライバシーポリシー：[OpenAI](https://openai.com/policies/privacy-policy/)、[OpenRouter](https://openrouter.ai/privacy)、[Google Gemini API](https://ai.google.dev/gemini-api/terms)、[Google Fonts](https://developers.google.com/fonts/faq/privacy)、[GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)

## 問題の報告

署名済みファイルの不正・誤用に気づいたら、[SECURITY.md](../SECURITY.md) の窓口と support@signpath.io に知らせてください。
