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

This program transfers information to other networked systems only in the following cases:

- When the user uses the AI features, the request (instructions, design content and images used for that operation) is sent to OpenAI (ChatGPT) without an additional confirmation step.
- When a font from the catalog is needed, the font name is sent to Google Fonts. The text of the user's designs is never sent.
- At every startup, and when the user chooses to check for updates, the program checks GitHub Releases for a newer version. Update files are downloaded only after the user agrees.

No analytics, telemetry or crash reports are collected.

詳しい内容（日本語）は [プライバシー](./privacy.md) にまとめています。プライバシーの正本はこの 1 つで、上の英文はその要約です。

## 問題の報告

署名済みファイルの不正・誤用に気づいたら、[SECURITY.md](../SECURITY.md) の窓口と support@signpath.io に知らせてください。
