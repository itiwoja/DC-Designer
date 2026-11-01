# プライバシー

DC-Designer の Windows 版アプリと紹介サイトが、どの情報をどこへ送るかをまとめます。この文書がプライバシーについての正本です（紹介サイトとコード署名ポリシーはこの文書を読み込むか、ここへリンクします）。

## まとめ

- 作品・画像・資料は、お使いの PC の中（`%LOCALAPPDATA%\DC-Designer`）に保存します。開発者のサーバーへは送りません。
- 外へ送るのは、**AI の機能を使ったとき（ChatGPT）**、**画像を生成するとき（Gemini・ChatGPT（Codex CLI）を選んだ場合だけ）**、**フォントを取得するとき（Google Fonts）**、**更新を確認するとき（GitHub Releases）** の 4 つだけです。更新の確認は、起動するたびに自動で行います。
- AI の操作をすると、**追加の確認なしで**その内容を ChatGPT（OpenAI）へ送ります。
- 利用状況の解析、テレメトリ、クラッシュレポートは集めていません。紹介サイトも Cookie を使わず、閲覧数を数えていません。

## Windows 版アプリが外へ送るもの

Windows 版は、次の表の送信先にだけ通信します。画面からの外への通信はすべて止め、AI とフォントの通信は送信先の許可リストに合うものだけを通しています。更新の確認は GitHub Releases にだけ問い合わせます。

どの送信先にも、通信の性質上、お使いの回線の IP アドレスが届きます。

| いつ | 送信先 | 送るもの |
| --- | --- | --- |
| 「ChatGPTでログイン」でサインインするとき、サインアウトするとき | OpenAI（`auth.openai.com`） | サインインに必要な認証の情報 |
| AI でレイアウトを作るとき、AI で修正するときなど、AI の操作をしたとき | OpenAI（`api.openai.com`） | 入力した指示文、作品の内容（文字・配置など）、その操作で使う画像（参考画像や、比べるために書き出した作品の画像など） |
| 画像生成で「Gemini（API キー）」を選んで生成したとき | Google（`generativelanguage.googleapis.com`） | 画像の説明（プロンプト）・画風・配色の指示と、あなたが設定画面に入れた API キー。参考画像は送りません |
| カタログのフォントを選んだとき、まだ PC に無いフォントを使った作品を開いたとき | Google Fonts（`fonts.googleapis.com`・`fonts.gstatic.com`） | フォントの名前など、フォントを選ぶための情報だけ。**作品の文字は送りません** |
| 起動したとき（自動で更新を確認）、「ヘルプ → 更新を確認」を選んだとき、更新を受け取ると決めたとき | GitHub（GitHub Releases） | 公開されている最新版の情報を取りにいく通信だけ。作品などの情報は送りません。更新のファイルは、画面で受け取ると決めてから取得します |

### AI の機能について

- AI の機能を使うには、ChatGPT Plus / Pro などの対象プランでサインインする必要があります。ChatGPT の無料プランでは使えません。
- AI の操作をすると、追加の確認なしで送信します。送信する前に、アプリの中で送信先と送る内容が正しいかを確かめ、確かめた内容だけを 1 回送ります。
- 送った内容の扱いは OpenAI のプライバシーポリシーに従います。
- Windows 版では、OpenRouter は使いません。画像生成に OpenAI の API キーを使うこともしません。

### 画像生成について

画像生成は、設定画面で選んだ方法ごとに、送り先が変わります。選ばなければ、仮の画像（文字入りのグラデーション）になり、何も送りません。

- **Gemini（API キー）**：あなたが設定画面に入れた API キーを使います。キーは Windows の暗号化保存（safeStorage）で PC の中に保存し、画面には読み戻しません。生成するときに、作りたい画像の説明・画風・配色を Google の Gemini API へ送ります。参考画像は送りません。送った内容の扱いは Google のプライバシーポリシーに従います。
- **ComfyUI（この PC）**：この PC（`127.0.0.1`・`localhost`・`[::1]`）で動いている ComfyUI にだけ送ります。外部の URL は設定できません。ただし、ComfyUI の workflow やカスタムノードがさらに外へ送るかどうかは、このアプリでは制御できません。
- **ChatGPT（Codex CLI）**：あなたが自分で入れて `codex login` した Codex CLI を、このアプリが起動して使います。ChatGPT プランの枠で生成するため、画像の説明（文字のプロンプト）が Codex CLI から OpenAI へ直接送られます。参考画像は渡しません。この通信はアプリの外部通信の許可リストを通らず、Codex CLI が行います。Codex CLI を動かす間だけ、あなたの Codex のサインイン情報（`auth.json`）をアプリ専用のフォルダ（`%LOCALAPPDATA%\DC-Designer\cache\codex-home`）に写し、終わったら消します（更新されたトークンはあなたの `auth.json` へ書き戻します）。結果は、その実行で作られた画像だけを使い、あなたの `~/.codex/generated_images` は読みません。

注意：この画像生成の機能は、Windows の実機での確認がまだ済んでいません。

### PC の中に保存するもの

- 作品・取り込んだ画像・資料は `%LOCALAPPDATA%\DC-Designer` に保存します。アンインストールや更新では消しません。消したいときは、アプリを終了してからこのフォルダを削除してください（ChatGPT のサインイン情報と、保存した Gemini の API キーも消えます）。
- ChatGPT のサインイン情報と Gemini の API キーは、Windows の保護機能（DPAPI）で暗号化して PC の中に保存します。
- 作品・画像・サインイン情報・API キーは、ログ・更新の通信・配布物には含めません。

## 紹介サイト

- 紹介サイトは Cookie を使いません。開発者は解析ツールを入れておらず、閲覧数も数えていません。
- ただし、サイトの配信（GitHub Pages）と exe のダウンロード（GitHub Releases）は GitHub が行います。そのため、GitHub が閲覧者の IP アドレスなどを、GitHub のプライバシー方針に従って記録します。

## 送信先のプライバシーポリシー

- [OpenAI](https://openai.com/policies/privacy-policy/)
- [Google Fonts](https://developers.google.com/fonts/faq/privacy)
- [GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)

## お問い合わせ

不具合やご質問は [GitHub の Issues](https://github.com/itiwoja/DC-Designer/issues) へお寄せください。セキュリティの問題は [SECURITY.md](../SECURITY.md) の窓口へお知らせください。
