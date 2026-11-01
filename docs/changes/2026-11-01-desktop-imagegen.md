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
- 製品版では、Gemini・ComfyUI の失敗（キーが無効・枠切れ・ComfyUI が起動していないなど）が、画面ではすべて「内部エラーが発生しました」になる（`server/route-handlers.ts` が 4xx 以外の例外の中身を隠すため）。利用者が原因を直せるよう、案内してよい文言を返す形にするかを決める。
- Codex の自動検出は PATH と npm のグローバル配置だけを見るため、Codex デスクトップアプリ同梱の `codex.exe` は見つけられず、設定で場所を指定する必要がある。
- Windows Job オブジェクトでの起動はしていない。中断は `taskkill /T` で、子孫プロセスの回収は保証しない。
- Codex のバージョン検証はしていない。
- Codex は子プロセスのため、worker の外部通信ゲートを通らない。ComfyUI 側の workflow・custom node がさらに外へ送るかも、アプリでは制御できない。
- `docs/desktop-release-spec.md` と `docs/README.md` などに「段階1〜3は Codex・ComfyUI 無効」の記述が残る。この更新の対象外だったため、別途直す。
