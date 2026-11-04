# 開発者向け

[README に戻る](../README.md)

## 構成

| パス | 役割 |
| --- | --- |
| `desktop/main.ts` / `desktop/startup.ts` | exe の依存処理の組み立て / 単一起動・窓のライフサイクル・起動失敗時の後始末 |
| `desktop/appHandler.ts` / `desktop/appProtocol.ts` | `app://` の静的ファイル配信 / URL・CSP・配信対象の制限 |
| `src/main.tsx` / `src/Application.tsx` | React の起動 / 画面ごとの遅延読み込み。exe では API の準備完了後に画面を開く |
| `src/schema.ts` | PosterSpec のスキーマ（zod）。レイヤー型: `background` / `shape` / `text` / `image` / `component` / `group` |
| `src/themes.ts` | テーマ（色・グラデーション・フォントのトークン）。`$primary` などのトークンで色指定するので、テーマ切替だけで配色違いが作れる |
| `src/components/catalog.ts` | コンポーネント一覧と props 定義。**エディタとChatGPTのプロンプトの両方がここを参照** |
| `src/components/index.tsx` | 各コンポーネントの SVG 実装（ピル、QR、吹き出し、付箋、PC/スマホモック、ポラロイド、キラキラ…） |
| `src/render/` | SVG レンダラ、テキスト（縁取り・自動縮小）、書き出し |
| `src/render/offscreen.ts` | サムネイル・PNG・PPTX で共用する画面外描画。SVG 定義 ID の隔離・フォント待機・後始末 |
| `src/render/svg.ts` / `src/render/pdf.ts` / `src/render/export.ts` | SVG・PNG の書き出し / ポスターの PDF の書き出し / PPTX の書き出し（PowerPoint ライブラリは書き出し時に読み込む） |
| `src/editor/` | エディタ UI |
| `server/app.ts` | API の組み立て、アクセス制御、終了時の書き込み待機 |
| `server/routes/` | 認証・AI 生成/編集・画像・フォント・成果物管理・設定の API |
| `server/route-handlers.ts` | JSON / NDJSON の応答、エラー処理、接続切断時のキャンセル |
| `server/planner.ts` | ChatGPT でブリーフ → PosterSpec / チャットのメッセージ（直近の会話つき）→ 返答 + 修正後の PosterSpec。zod 検証に失敗したら 1 回だけ自動修正 |
| `server/chatgpt-auth.ts` | Sign in with ChatGPT（OAuth/PKCE、ID トークン検証、トークン更新、資格情報の保存） |
| `server/chatgpt.ts` | ChatGPT プランでの推論（Responses API、`store:false` / `stream:true`） |
| `server/openrouter.ts` | OpenRouter での推論（Chat Completions 互換 API、ストリーム） |
| `server/ai.ts` | レイアウト生成・AI 修正に使う AI（ChatGPT / OpenRouter）の選択と呼び出し |
| `server/library.ts` | 成果物（保存したポスター `data/posters/*.json` と画像 `public/generated/`）の管理 |
| `src/editor/Home.tsx` | ホーム画面（`/`）。新規作成の入口と最近の成果物 |
| `src/editor/nav.ts` | 画面の URL・白紙 spec・成果物をエディタで開く処理（ホームと成果物管理で共用） |
| `src/editor/Library.tsx` | 成果物の管理画面（`?view=library`） |
| `server/imagegen.ts` | 画像生成（OpenAI gpt-image-2.5-flare（透過PNG対応）／Gemini Interactions API／ローカルの ComfyUI／実験的に Codex CLI 経由）。リクエストごとにプロバイダ指定可。同じプロンプトはキャッシュ |
| `src/import/pptx.ts` | PPTX の読み込み（JSZip + DOMParser でスライド → PosterSpec。テーマ色・プレースホルダーの継承を解決） |
| `src/editor/DeckStrip.tsx` | PPTX エディターモードのスライド一覧 |
| `src/fonts.ts` / `server/fonts.ts` | フォントのカタログと全スライドへの適用 / ChatGPT による提案と OS へのインストール |
| `src/editor/FontDialog.tsx` | フォントの提案・選択ダイアログ |

## 拡張のしかた

- **コンポーネント追加**: `catalog.ts` にエントリ（説明と props）を追加し、`components/index.tsx` の `RENDERERS` に描画関数を追加。カタログの説明は自動で ChatGPT のプロンプトに入る。
- **テーマ追加**: `themes.ts` に同じトークン名を持つテーマを追加。
- **画像モデル変更**: `server/imagegen.ts` にプロバイダ関数を追加して `IMAGE_PROVIDER` で切り替え。

## 成果物の API

| API | 内容 |
| --- | --- |
| `GET /api/posters` / `POST /api/posters` | 一覧 / 作成（`{ spec }`） |
| `GET` `PUT` `DELETE /api/posters/:id` | 取得 / 更新（`{ spec }`） / 削除 |
| `POST /api/posters/:id/duplicate` | 複製 |
| `POST /api/generated/list` / `POST /api/generated/delete` | 画像一覧 / 未使用画像の削除（`{ names }`）。`specs` に保存前の spec を渡すと、そこで使われている画像も使用中として扱う |

## デッキ・フォントの API

| API | 内容 |
| --- | --- |
| `GET /api/decks` / `POST /api/decks` | デッキ一覧 / 作成（`{ name, specs }` → スライドごとにポスターを作成） |
| `POST /api/decks/:id/duplicate` / `DELETE /api/decks/:id` | 複製（スライドごと） / 削除（スライドのポスターもまとめて削除） |
| `GET` `PUT /api/decks/:id` | 取得 / 名前・並び順の変更（`{ name?, slides? }`） |
| `POST /api/decks/:id/slides` / `DELETE /api/decks/:id/slides/:posterId` | スライド追加（`{ spec?, after? }`、spec 無しなら after を複製） / 削除 |
| `GET /api/posters/:id/deck` | そのポスターが入っているデッキ |
| `POST /api/fonts/suggest` | フォントの提案（`{ mood, title, texts }` → 3 案） |
| `POST /api/fonts/status` / `POST /api/fonts/install` | インストール状況の確認 / 未インストールのものをインストール（`{ families }`、カタログのフォントのみ） |

## PowerPoint 書き出しの計測

デッキの書き出しは、終わるとコンソールに 1 行出す（例 `[pptx] 12 枚 3.4s（準備 2.1s / write 0.8s / 仕上げ 0.5s）同時 3 メモリ最大 210MB`）。メモリは Chromium で取れたときだけ付く。同時に処理する枚数は既定 3 で、開発者ツールのコンソールで変えられる。

製品版（パッケージ済み）はメニューに開発者ツールが無く（`desktop/main.ts` の「開発」メニューは未パッケージのときだけ）、この行は見られない。Windows では `npm run dev` を Chrome で開くか、未パッケージの Electron で開発者ツールを開いて計測する。

1. 画像・図形の多い 10〜20 枚のデッキを開く（毎回同じデッキを使う）。
2. コンソールで `localStorage.setItem("dc.pptxConcurrency", "1")` と打つ（次の書き出しから効く。1〜6、消すと 3 に戻る）。
3. 「PowerPoint を書き出し」を実行し、`[pptx]` の行を控える。値を 1・3・6 に変えて同じことを繰り返す（各 2 回、1 回目は読み込みの影響があるので 2 回目を使う）。
4. 「全体」「準備」「メモリ最大」を比べる。準備が縮まらない値から先は増やしても効かない。メモリが増えすぎる値は避ける。

## 以前の Instagram 投稿モード

Instagram 投稿モードは廃止した（機能をポスター作成とスライド作成の 2 つに絞ったため）。以前の版で作った投稿（デッキ `kind: "instagram"`）は `data/` に残したまま消さないが、ホーム・成果物の一覧には出さない（`src/editor/mode.ts` の `isShownDeck`）。

## Windows版の配布・更新方針

Windows用インストーラー、配信CI（`v*` タグで起動。[配布・更新ポリシー](./release-policy.md#1回の配信手順)）、起動時の更新確認（v1.0.3から）はある。コード署名（SignPathの審査待ち。それまでは未署名で公開し、更新ファイルはSHA-512だけで確かめる）・配信権限の制限は未実装・未設定。

- 対象はWindowsのみ。インストーラーと更新ファイルは公開GitHub Releasesで配り、コード署名はSignPath Foundationを使う（段階3のビルドが揃ってから申請）。署名の方針は [Code signing policy](./code-signing-policy.md)。実装は段階1〜4に分けて進める（[段階分け](./desktop-release-spec.md#phases)）。
- Windows版でも画像生成（Gemini＝利用者のAPIキー、ComfyUI＝この PC のloopbackのみ、ChatGPT＝Codex CLI経由）を使える（2026-11-01。Windows実機での確認は一部）。Codex CLIは自動で探し（PATH・npm・Codexアプリ同梱）、無ければ設定画面のボタンで固定版（公式GitHubリリース、sha256照合）を入れてそのまま`codex login`までできる。ChatGPTへサインインすると、この準備（探す→無ければ裏で取ってくる→`codex login`）も自動で続けて行う（2026-11-02）。生成の失敗は原因と直し方の分かる文言で出す。参考画像は渡さず文字のプロンプトだけを送る。Codexは外部通信ゲートを通らずOpenAIへ直接通信する。OpenAI APIキーでの画像生成とOpenRouterはWindows版では使わない。詳細は[プライバシー](./privacy.md)、[変更記録](./changes/2026-11-01-desktop-imagegen.md)。
- 日常の開発は `main` で行い、配布するタイミングで `main` を `release` にマージする。チェリーピックは原則使わない。
- `main` / `release` へのpushやマージだけでは配信しない。`release` 上で確認したコミットに `v1.0.1` などのタグを付け、正式配信を開始する。
- **正式配信の権限・最終承認は、リポジトリ所有者の @itiwoja 本人だけが持つ。** 自動ビルド・公開は、本人が承認した処理として実行する。
- 利用者のアプリは**起動するたびに**更新をバックグラウンドで確認し、新しい正式版がある場合だけ**アプリ内ポップアップ**で案内する。「更新する」でダウンロードし、完了後に「保存して再起動」を選んで適用する。「あとで」なら次回起動時に再通知する。
- オフラインでも通常起動・編集を続けられる。無断ダウンロード・通常終了時の自動適用・強制再起動はせず、資料・画像・設定・認証情報は通常の更新で維持する。

- exe版では、利用者の画像・資料・資格情報を配布物やログに混ぜない。AIの送信・生成操作は追加の「AIへ送信する内容の確認」ダイアログなしで実行する（送信先・本文・画像の検証は内部で行う）。
- フォント取得は維持し、作品の文字を取得先へ送らず、検証したフォントをPC内で利用する設計とする。

exe版の設計資料は [`docs/`](./) に集約している。exe化本体の設計は [Windows exe版 release設計](./README.md)、手順・権限制限・配布物の安全条件は [配布・更新ポリシー](./release-policy.md)、更新の画面・動作は [起動時の更新確認・ポップアップ設計](./desktop-update-design.md) を参照。これらは設計であり、現在のWeb版に画像送信確認・フォント通信制限等が実装済みという意味ではない。
