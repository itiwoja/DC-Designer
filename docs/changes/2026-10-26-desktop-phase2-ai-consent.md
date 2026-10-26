# 段階2（後半）の実装メモ：AI送信確認とChatGPTサインイン（2026-10-26）

[段階分け](../desktop-release-spec.md#phases)の段階2のうち、AI送信確認（EXE-FR-004、EXE-SCR-002、EXE-API-003/004相当）と秘密情報設定（EXE-SCR-004）を実装した。製品版で有効にするAIはChatGPTプランだけ（ユーザー回答）。画面からAI操作（生成・修正）を呼ぶ操作表への追加は次に行うため、製品版のAI機能はまだ画面から使えない。

## 作ったもの

| 項目 | 場所 |
| --- | --- |
| 送信内容の形・canonical payload・payloadHash・main側の検証（画像bytesのハッシュし直し） | `desktop/aiPayload.ts` |
| worker↔mainの`ai-consent`・`ai-consent-result`・`ai-outcome`（`API_PROTOCOL_VERSION`=3） | `desktop/protocol.ts`、`desktop/runtime.ts` |
| workerの送信ゲート（送る直前に確認を依頼し、approveかつハッシュ一致の時だけsnapshotを1回送る。製品版は自動再送なし・送達不明を区別・リダイレクトを追わない） | `server/ai-consent.ts`、`server/chatgpt.ts`、`server/desktop-worker.ts` |
| 製品版はChatGPT固定（OpenRouter・画像生成のOpenAI/Geminiは無効） | `server/ai.ts`、`server/imagegen.ts` |
| mainの確認状態機械と待ち行列（メモリだけ、期限5分、1つずつ表示、worker喪失で破棄） | `desktop/aiConsent.ts` |
| 確認窓（別BrowserWindow・別preload・永続しないpartition、scriptを禁止したHTMLにpreloadがDOMを組み立てる。初期フォーカスは「送信しない」、Esc・閉じるは拒否、送信ボタンは表示から1秒後・Enter無効） | `desktop/consentWindow.ts`、`desktop/consentPreload.ts` |
| ChatGPTサインイン（mainが既定のブラウザで`https://auth.openai.com/`だけを開き、一時的なループバックの受け口でstateが一致するコールバックだけをworkerへ渡す） | `desktop/authGate.ts`、`server/chatgpt-auth.ts`の`completeLogin`、`server/app.ts`の製品版専用route |
| 画面のアカウント表示（未サインイン・サインイン済み・プラン不可・再認証が必要、サインイン・別アカウント・ログアウト） | `src/editor/DesktopAccount.tsx`、`src/editor/accountView.ts` |
| 操作表：画面向けに`auth.logout`、main内部専用に`auth.start`・`auth.complete` | `desktop/operations.ts` |

## 決めたこと・設計から外れた判断

- **送信先**：製品版はChatGPTプランだけ（ユーザー回答）。OpenRouterの単一推論先の固定は、OpenRouterを有効にするときに実装する。
- **workspaceRevision・ownerContext**：workerの`askChatGPT`は作品revisionを知らないため、許可は`requestId`・`payloadHash`・確認窓のwebContentsに結び付けた。AI操作を操作表に足すときに見直す。
- **確認依頼の作り手**：EXE-API-003の`prepareAiRequest`を画面から呼ぶ形ではなく、workerが送る直前に実bytesから作ってmainへ依頼する形にした（画面の自己申告を通らない）。
- **送信前の通信**：アクセストークンの更新とモデル一覧（`GET /models`）は作品内容を含まないため確認の対象外。
- **多段のAI処理**：`askChatGPT`の1回ごとに確認する。再現→修正のような処理では確認が複数回出る。
- **資格情報の渡し方**：workerは引き続き`secret-get`でChatGPTの資格情報を受け取れる（承認済みの送信だけに絞ることは未実装）。
- 確認窓の表示ロジックはpreload（isolated world）に置き、ページのCSPは`default-src 'none'; img-src data:`でscriptを持たない。

## 確認したこと

- 型チェック、全テスト（vitest、52ファイル・495件）、`npm run desktop:build`（確認窓のpreloadがelectronだけをrequireする1ファイルになり、配布物検査も通ること）。
- 単体テストで確認したこと：approveとハッシュ一致で1回だけ送る、拒否・期限切れ・不正・ハッシュ不一致・main無応答で送信0回、製品版でストリームが切れても再送しない、開発版はゲートを通らない、承認は確認窓のsenderから1回だけ、Esc・閉じるは拒否、待ち行列、worker喪失での破棄、サインインのstate不一致・許可外ホストの拒否、やり直しは1回だけ、期限切れで受け口を閉じる、同時サインイン。

## 未確認・残り

- Windows実機での確認：確認窓の表示・キーボード操作・読み上げ、既定のブラウザでのサインインとループバックの受け口（ファイアウォールの表示を含む）、サインイン後の資格情報がDPAPIで保存されること。
- 画面からのAI操作（plan/edit/slide/notes/reproduce等）を操作表に足し、NDJSONの進み具合をIPCで流す（[実装済み](./2026-10-26-desktop-phase2-ai-ops.md)）。参考画像付きの操作で確認窓が出ることの通し確認。
- 承認済みの送信のときだけ資格情報を渡すこと、作品revisionへの結び付け。
