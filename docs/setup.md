# セットアップと AI の設定

[README に戻る](../README.md)

## 画像生成

- 画像生成は OpenAI（gpt-image）と Gemini（`gemini-3.1-flash-image` ほか）に対応。キーを入れた方が使え、両方入れると左下の歯車 → AI の設定 → 「画像生成」で切り替えられる（既定は `IMAGE_PROVIDER`）
- ローカルで動かしている [ComfyUI](https://github.com/comfyanonymous/ComfyUI) でも生成できる（API キー不要・GPU で生成）。「画像生成」の選択肢に常に「ComfyUI（ローカル）」が出る。接続先は `COMFYUI_URL`（既定 `http://127.0.0.1:8188`）。既定は SDXL 系の txt2img ワークフローで、チェックポイントは `COMFYUI_CHECKPOINT`（未指定なら最初に見つかったもの）。Flux などは `COMFYUI_WORKFLOW` に API 形式のワークフロー JSON を指定し、`{{prompt}}` `{{negative}}` `{{width}}` `{{height}}` `{{seed}}` を埋め込む
- Gemini / ComfyUI は透過背景を出せないため、透過アセット（`transparent: true`）は `OPENAI_API_KEY` があれば OpenAI で生成し、無ければ白背景で生成する
- AI でレイアウトを生成・修正すると、未生成の画像はそのまま自動で生成される（左下の歯車 → AI の設定 → 「AI のレイアウト生成・修正のあと画像も自動で生成」のチェックで OFF にできる）。プロンプトにはポスター共通の画風（`meta.imageStyle`、無ければテーマの `imageStyle`）・テーマの主要色・置かれる大きさ（主役／添え／挿絵）・入れ物（ノートPC・スマホ・ポラロイド）の指示が自動で足され、image レイヤーは枠の縦横比に合わせて生成する
- API キーがなく、ComfyUI・Codex も選択・設定していない場合、画像はダミー（プロンプト文字入りのグラデーション）になる。レイアウト確認だけならこれで十分。
- 指定したプロバイダが使えないときは、OpenAI → Gemini → `COMFYUI_URL` を明示している場合のみ ComfyUI → ダミーの順に切り替わる。ComfyUI・Codex は接続や CLI のログインを事前に確認しないため、選ばれたあとに失敗するとエラーになる（ダミーには落ちない）。
- ChatGPT にサインインしていなくても、白紙からの手動編集・書き出しは使える。

## Sign in with ChatGPT

レイアウト生成と AI 修正は ChatGPT で行う。エディタ左下の「ChatGPTでログイン」でサインインすると、ChatGPT Plus / Pro のプラン枠で使える（API キー不要）。左下にはアカウントのメニューと ⚙（AI の設定）もある。

- **ChatGPT 無料プランはこの連携に非対応**（2026-10-26 の利用者による動作確認）。ChatGPT Plus / Pro などの対象プランと、ChatGPT プランをこのアプリで使う許可が必要。デスクトップ版の手動編集・保存・書き出しはサインイン不要。
- [OpenAI の OSS 向けフロー](https://developers.openai.com/siwc/token-sharing-open-source)（`dynamic_agent_client` による動的登録 + PKCE）を使う。初回に発行された `client_id` は保存して再利用する
- コールバックは `http://127.0.0.1:<API_PORT>/auth/callback`。API サーバーが直接受ける
- 資格情報は `~/.config/dc-designer/chatgpt.json`（0600）に保存。アクセストークンは利用時に有効期限（サーバーから返る `expires_in` に基づく）を確認し、期限の 60 秒前以降なら自動更新する
- **画像生成の経路は 2 通り**。OpenAI / Gemini の API 経由は各 API キー（`OPENAI_API_KEY` / `GEMINI_API_KEY`）を使い、ChatGPT プランの枠は使わない
- `IMAGE_PROVIDER=codex` で Codex CLI の `image_gen` を使える（API キー不要）。アプリ内のサインインとは別に、Codex CLI 側で `codex login`（ChatGPT ログイン）が必要で、画像は ChatGPT プランの枠を消費する。Codex CLI の導入が必要。Codex CLI 0.160.1 以降で WSL でも動作確認済み（古い版は [openai/codex#19133](https://github.com/openai/codex/issues/19133) でツールが出ない）。1 枚ずつ直列生成で 1 枚 40〜60 秒ほど
- 使用量・上限は [ChatGPT の設定 → 使用状況](https://chatgpt.com/settings/usage) で管理する

## OpenRouter

`.env` に `OPENROUTER_API_KEY` を入れると、ChatGPT にサインインしなくてもレイアウト生成・AI 修正・フォント提案を [OpenRouter](https://openrouter.ai) 経由で使える（OpenRouter のクレジットを消費する）。`.env` を変えたら API サーバーを再起動する。

- モデルは AI の設定かチャット欄で選べる（画像を読めて文章を返すモデルだけを一覧に出す。参考画像の再現・見比べで画像を渡すため）。選んだモデルは `data/openrouter-model.json` に保存し、「自動」のときは `OPENROUTER_MODEL`（既定 `anthropic/claude-sonnet-5.5`）
- ChatGPT と両方使えるときは、左下の歯車 → AI の設定 → 「AI」で切り替える（自動のときは `AI_PROVIDER`、未指定なら ChatGPT プランを優先）。選んだ AI が使えないときは、もう一方に切り替えずにエラーにする
- 応答が出力の上限で切れるときは `OPENROUTER_MAX_TOKENS` を増やす
