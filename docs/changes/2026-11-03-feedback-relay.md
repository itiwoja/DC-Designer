# アプリ内から要望・不具合を送る機能を、中継サーバー経由で GitHub の Issue を作る方式にする（2026-11-03）

決定者：ユーザー（Issue #77。「GitHub のアカウントが無くてもできるようにしたい」）

## なぜ

[2026-11-02 の記録](./2026-11-02-feedback-issue.md)では、利用者が自分の GitHub アカウントで Issue 作成画面から送る方式にした。この方式は、GitHub のアカウントを持たない利用者が要望や不具合を送れない。ユーザーは、アカウントが無くても送れるようにすることを決めた。

そのため、送り先の GitHub への書き込みをアプリの外に置く中継を作る。前の記録では、中継サーバーは運用・スパム対策・シークレットの管理・プライバシーポリシーの改訂が要るため採らなかった。今回は、その費用を払うことを選んだ。

## 何を変えたか

- 送る流れ：画面（エディタのフォーム）→ アプリのサーバー `POST /api/feedback`（`server/routes/feedback.ts`）→ 中継の Cloudflare Worker（`relay/`、`https://dc-designer-feedback.1kki-mrkm22.workers.dev/v1/issues`）→ GitHub の REST API（`POST /repos/itiwoja/DC-Designer/issues`）。
  中継は GitHub App（Issues の読み書きだけ、このリポジトリだけにインストール）のインストールトークンで Issue を作る。作成者は App の Bot（`<App 名>[bot]`）になる。App の ID・インストール ID・秘密鍵（PKCS#8）は Worker のシークレット（`relay/README.md`）。
- 製品版では、画面からの外への通信を止めたままにする。画面は中継を直接呼ばず、必ずアプリのサーバーを経由する。外部通信の許可表（`server/egress.ts`）には、中継の `POST /v1/issues` だけを 1 件足す。
- 中継に送るのは、種類（要望・不具合・質問）、件名、内容と、「アプリの版と OS を添える」にチェックが入っているときだけのアプリの版・製品版か開発版か・OS。
- 作られた Issue には `from-app` と種類のラベル（enhancement・bug・question）を付け、本文の末尾に「アプリ内から匿名で送られました」と入れる。本文の `@` の直後と、ほかのリポジトリへの参照（`owner/repo#123`）の `#` の直後にゼロ幅スペースを入れて、メンションと「参照されました」の通知を無効にする。
- 件名は 200 文字、本文は 6000 文字まで。型・定数・検証は `desktop/feedbackRelay.ts` に置き、アプリのサーバーと中継の両方で同じ検証をする。
- 中継のレート制限は、IP アドレスごとに 1 分 3 回、全体で 1 分 30 回（`relay/wrangler.jsonc`）。IPv6 はアドレスを替えて逃れられないよう /64 ごとに数える。Workers の Rate Limiting は Cloudflare の拠点ごとに数えるので、「全体」も拠点ごとの上限になる。IP は送信回数の制限にだけ使い、保存しない。Cloudflare の通信の性質上、IP アドレスは中継に届く。
- 中継は 1 回の送信を 12 秒（トークンの取り直しを含む）で打ち切る。アプリのサーバーは 15 秒で諦めて予備の方式を出すので、その後で Issue ができて利用者が 2 回送ることにならないようにする。
- 中継が送れないときの予備として、従来のブラウザで GitHub の Issue 作成画面を開く方式を選べるようにする（[2026-11-02 の記録](./2026-11-02-feedback-issue.md)）。
- [プライバシー](../privacy.md)を直す。外へ送るものは 5 つになり、要望・不具合の送信（中継）を表と節に足した。送信先に Cloudflare を足した。

## 確かめたこと

- `npx tsc --noEmit`、`npx vitest run`（82 ファイル・884 件。中継は `tests/feedbackRelay.test.ts`、アプリのサーバーは `tests/feedbackRoute.test.ts`・`tests/egress.test.ts`、画面は `tests/feedbackDialog.test.tsx`）、`npm run build` が通る。
- `npx wrangler deploy --dry-run --config relay/wrangler.jsonc` で中継がビルドできる。
- 開発版をヘッドレスの Chromium で開き、エディタ左下のボタンからフォームを開いて送ると、中継が無い状態では「いまは送れませんでした」とブラウザで送る予備のボタンが出ることを見た。
- 中継をデプロイし（`from-app` ラベルを先に作成、トークンは fine-grained PAT）、開発版のアプリのサーバー経由で 1 件送って [#82](https://github.com/itiwoja/DC-Designer/issues/82) ができることを見た。件名の接頭辞、`question`・`from-app` のラベル、環境節、末尾の注記、`@` の無効化が入っていた。確認後に閉じた。
- 作成者が PAT の持ち主（`itiwoja`）の名義になったため、ユーザーの指示で GitHub App（`DC-Designer Feedback`）に切り替えた（開発者個人の名義で起票しない）。切り替え後に 1 件送り、[#83](https://github.com/itiwoja/DC-Designer/issues/83) の作成者が `dc-designer-feedback[bot]` になったことを見て閉じた。旧シークレット `GITHUB_TOKEN` は Worker から消した。

## 採らなかったもの

- 中継に開発者の fine-grained PAT を入れる方式：Issue の作成者が開発者本人の名義になるため。最初はこれで動かしたが、GitHub App に置き換えた。
- 専用の GitHub アカウント（machine user）：他人のリポジトリには fine-grained PAT を作れず、権限の広い classic PAT（`public_repo`）が要るため。

- GitHub にサインインして、利用者本人の名義で起票する方式：GitHub のアカウントが要るため、この依頼の目的（アカウント無しで送る）に合わない。
- アプリ内の窓で GitHub の Issue 作成画面を開く方式：GitHub のアカウントが要り、外部のサイトを Electron の窓で読み込むことになるため。予備は従来どおり外部のブラウザで開く。
- Turnstile（CAPTCHA）：呼び出し元はブラウザではなくアプリのサーバーなので、利用者の操作で確かめる仕組みが成り立たない。スパム対策はレート制限・サイズ上限・`from-app` ラベルで行う。
- アプリに GitHub のトークンを入れて、API で直接起票すること：アプリに入れたトークンは取り出せるため（前の記録と同じ理由）。

## 既知の制限

- Issue の作成者は GitHub App の Bot になる。送った人が誰かは GitHub 上では分からない。
- スパム対策はレート制限だけ。Turnstile は使わないため、回数の上限を超えない範囲の悪用は止められない。`from-app` ラベルで後から絞り込める。
- 中継の運用が要る。Bot のトークンの期限・入れ替え、Worker の監視、停止したときの案内（予備のブラウザ方式）を、開発者が続けて行う必要がある。
- 書いた内容は公開される。利用者の作品や個人情報は、フォームに入れないよう案内する必要がある。
- 製品版の中継への通信は、実機では確かめていない。
