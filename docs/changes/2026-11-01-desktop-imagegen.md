# Windows 版で画像生成を使えるようにする（2026-11-01）

段階1〜3の製品版では止めていた画像生成（Gemini・ComfyUI・Codex CLI 経由の ChatGPT）を、Windows 版で使えるようにした。決定者はユーザー。実装は `feature/desktop-imagegen` ブランチで進めている。この文書は、それに合わせた利用者向けの説明と設計文書の更新の記録。

## 何を変えたか

| 方法 | 動き | 送り先・保存先 |
| --- | --- | --- |
| Gemini | 設定画面で入れた API キーで生成する | キーは `safeStorage`（`gemini/apiKey`）。プロンプト・画風・配色を `generativelanguage.googleapis.com`（`/v1beta/interactions`）へ送る。外部通信の許可表に 1 件追加 |
| ComfyUI | この PC で動く ComfyUI に送る | `127.0.0.1`・`localhost`・`[::1]` だけ。外部 URL は設定できない |
| ChatGPT（Codex CLI） | 利用者が入れて `codex login` した `codex.exe` を直接起動（shell なし・窓なし）し、`image_gen` で生成する | アプリ専用の `CODEX_HOME`（`%LOCALAPPDATA%\DC-Designer\cache\codex-home`）に、実行の間だけ利用者の `auth.json` を写して終了後に消す。更新されたトークンは利用者の `auth.json` へ書き戻す。Codex は OpenAI へ直接通信する |

- Codex の結果は、その実行のスレッドのフォルダの画像だけを採用する。利用者の `~/.codex/generated_images` は読まない。
- 参考画像は Codex にも Gemini にも渡さない（送るのは文字のプロンプトだけ）。
- OpenAI の API キーでの画像生成と OpenRouter は、Windows 版では引き続き使わない。

## なぜこの形にしたか

- アプリの ChatGPT ログインのトークンで画像生成を直接呼ぶ方式は、OpenAI が `subscription_sharing_unsupported_capability`（`image_generation` ツールは非対応）で拒否するため使えない。そのため ChatGPT プランの枠で画像を作るには、利用者自身の Codex CLI を使う。
- ComfyUI は外へ出さない接続だけに絞り、利用者の PC の外の URL を設定できないようにした。

## 更新した文書

- `docs/privacy.md`：「画像生成について」を足し、送信先の表に Gemini を 1 行追加した。キーの保存先と、Codex のサインイン情報の扱いを書いた。
- `docs/desktop-release-privacy.md`：「段階1〜3では Codex・ComfyUI 無効」の記述を、有効にしたことと条件・残る差分に更新した。
- `docs/desktop-release-runtime.md`：「任意Codex連携の製品条件」を、満たした条件と満たしていない条件に分けた。
- `README.md`：Windows 版の画像生成の説明を足した。

## 確かめたこと

- 文書どうしで、古い記述（「Windows 版では画像生成を使わない」「Codex・ComfyUI は製品版で無効」）が残っていないことを grep で確かめた（下の「残り」の親仕様を除く）。
- Windows 実機での確認（2026-11-01、Windows 11 Build 26200・x64）。`npm run desktop:pack` で作った `win-unpacked\DC-Designer.exe` を、`LOCALAPPDATA` を検査用のフォルダに差し替えて起動し（インストール済みの版とデータには触れない）、Playwright で画面を操作した。
  - Codex：設定画面で `codex.exe` の場所（Codex デスクトップアプリ同梱の `%LOCALAPPDATA%\OpenAI\Codex\bin\…\codex.exe`、codex-cli 0.166.0-alpha.5.1）を保存すると「使えます」になり、生成した画像がキャンバスに置かれた（約 30 秒）。専用 `CODEX_HOME` の `auth.json` は実行中だけあり、終了後に消えた。生成の途中で中止すると「キャンセルしました」になり、`codex.exe` は残らず、`auth.json` も消えた。利用者の `auth.json` はハッシュが変わらなかった（トークン更新が無く、書き戻しは起きなかった）。
  - ComfyUI：この PC に ComfyUI が無いため、ComfyUI の応答をまねる偽サーバーを `127.0.0.1:8188` に立てて確かめた。モデル一覧の取得 → `/prompt` → `/history` の完了待ち → `/view` の順に呼ばれ、画像がキャンバスに置かれた。送られたのは文字のプロンプトだけだった。`http://example.com:8188` と `http://192.168.1.10:8188` は保存の時点で拒否された。
  - Gemini：本物の API キーが手元に無いため、無効なダミーのキーで確かめた。最初は**必ず失敗する不具合**があった（下記）。直した後は、`generativelanguage.googleapis.com` に接続し、Google から「API key not valid」が返るところまで確かめた。本物のキーでの生成は未確認。
- 実機で見つけて直した不具合：main が worker に読ませる資格情報を「ChatGPT のサインイン情報を、ChatGPT を使う操作の最中だけ」に限っていたため、worker が Gemini のキーを読めず、Gemini の生成が必ず失敗していた。操作の一覧に `readSecrets`（実行中だけ worker が読み出せる資格情報。読むだけで、書き換え・削除は不可）を足し、`images.asset` に `gemini/apiKey` を許した（`desktop/operations.ts`・`desktop/runtime.ts`、テストは `tests/desktopRuntime.test.ts`）。

## 残り（段階4の条件から外れる点を含む）

- 本物の Gemini API キーでの生成、本物の ComfyUI での生成、トークン更新が起きたときの `auth.json` の書き戻しは、実機で未確認。
- ~~製品版では、Gemini・ComfyUI の失敗が画面ではすべて「内部エラーが発生しました」になる~~ → 下の「追加」で対応。
- ~~Codex デスクトップアプリ同梱の `codex.exe` を自動検出しない~~ → 下の「追加」で対応。
- Windows Job オブジェクトでの起動はしていない。中断は `taskkill /T` で、子孫プロセスの回収は保証しない。
- Codex のバージョン検証はしていない（下の「追加」で、アプリが入れる固定版だけは sha256 で照合する）。
- Codex は子プロセスのため、worker の外部通信ゲートを通らない。ComfyUI 側の workflow・custom node がさらに外へ送るかも、アプリでは制御できない。
- `docs/desktop-release-spec.md` と `docs/README.md` などに「段階1〜3は Codex・ComfyUI 無効」の記述が残る。この更新の対象外だったため、別途直す。

## 追加：失敗の伝え方と、Codex CLI の自動検出・入れる・サインイン（2026-11-01）

ユーザーの依頼：失敗の表示を改善する。`codex.exe` を自動で見つけ、無ければワンクリックで入れ、読み込み中の表示を出す。版は固定する（ユーザーの決定。ハッシュが一致したものだけ入れる）。

- 失敗の伝え方：画像生成の失敗を `ImageGenError`（`server/imagegen-error.ts`）にし、製品版でも決まった文言と `code` を返す（`server/route-handlers.ts`）。文言にはパス・キー・外部の応答本文を入れず、詳細は開発版とログだけに残す。
  - Gemini：キー未設定・キーが正しくない・権限が無い・利用上限（429）・Google 側の失敗（5xx）・接続できない・画像が返らない、を分ける。
  - ComfyUI：起動していない（接続先の URL を出す。ループバックだけなので出してよい）・HTTP エラー・モデルが無い・ジョブ拒否・実行エラー・出力なし・時間切れ。
  - Codex：見つからない・サインインしていない・利用上限・途中で失敗・時間切れ など。stderr（パスを含みうる）は画面に出さない。
  - 画面：まとめて生成したときの「N 点の画像生成に失敗しました」に、最初の失敗の理由を足す（`src/editor/imageErrors.ts`）。
- 自動検出：PATH → npm のグローバル配置 → Codex デスクトップアプリ同梱（`%LOCALAPPDATA%\OpenAI\Codex\bin` の下、深さ 3 まで）→ アプリが入れたもの。時間のかかる探索は結果を 30 秒覚える。設定画面に見つけた場所の種類を出す。
- 入れる（`server/codex-setup.ts`・`server/codex-pinned.ts`）：Codex CLI 0.166.0 の公式 GitHub リリースの tar.gz（x64・arm64）を、`github.com` → 転送先（`release-assets.githubusercontent.com`・`objects.githubusercontent.com`）の順に取る。外部通信ゲートに固定パスと転送先を追加し、転送先のホストは呼び出し側でも確かめる。届いた大きさと sha256 がリリースの digest と一致したときだけ、tar の中の実行ファイルを `<userRoot>\tools\codex\0.166.0\codex.exe` に置く。中止・失敗では書きかけを消す。
- サインイン：見つかった `codex.exe` で `codex login` を shell なし・窓なしで起動し、利用者の既定の `CODEX_HOME` に `auth.json` ができたら済み。`codex login` が出す認可 URL（`auth.openai.com/oauth/authorize?` で始まるものだけ）を画面に渡し、ブラウザが開かないときのリンクにする。待つあいだは 30 秒ごとに進み具合を送り直す（main が worker の応答を読む fetch は、本文が 300 秒途切れると切れるため）。10 分で打ち切る。
- 読み込み中の表示：設定画面の Codex 欄に、ダウンロードの進み具合（バー・%・MB）→「確かめています」→「入れています」→ サインイン待ち を出し、中止できる。入れ終えてサインインしていなければ、続けてサインインを始める。設定の吹き出しを閉じても処理は続く（`src/editor/codexSetup.ts`）。操作は `codex.install`・`codex.login`（stream。資格情報は渡さない）。
- 確かめたこと：単体テスト（偽の tar.gz・偽の fetch での入れる処理、sha256 不一致・想定外の転送先・中止、偽の `codex login`、許可表、進み具合の検証、画面の流れ）と型検査、`npm run desktop:build`。**Windows 実機では未確認**（本物の GitHub からの取得、Codex アプリ同梱の検出、`codex login` がブラウザを開くか、窓なしで動くか）。
- 残り：版を上げるには `server/codex-pinned.ts` を書き換えてアプリを更新する必要がある。利用者が入れた CLI・Codex アプリ同梱の CLI の版は検証しない。1 枚の生成中の細かい進み具合（順番待ち・生成中）は出していない（従来どおり、全体の「N / M 点」とスピナー）。
