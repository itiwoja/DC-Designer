# 段階2の実装メモ：画面からのAI操作（2026-10-26）

[段階2（後半）の実装メモ](./2026-10-26-desktop-phase2-ai-consent.md)の残り「画面からのAI操作を操作表に足し、NDJSONの進み具合をIPCで流す」を実装した。製品版でも生成・修正・再現・台本・要約・フォント提案を画面から使える。送信の確認（確認窓）は既存のworkerのゲートをそのまま通る。

## 作ったもの

| 項目 | 場所 |
| --- | --- |
| 操作表に`ai.plan`・`ai.planInstagram`・`ai.reproduce`・`ai.reproduceRefine`・`ai.edit`・`ai.slide`・`ai.notes`・`ai.summarize`・`fonts.suggest`・`chatgpt.model`を追加。NDJSONのrouteは`stream: true`。画像生成（`/api/asset`）は載せない | `desktop/operations.ts` |
| 橋に`request(req, { callId, onProgress })`と`cancel(callId)`、IPC`dc:api-progress`・`dc:api-cancel` | `desktop/bridge.ts`、`desktop/preload.ts` |
| 取り消しの管理（senderのwebContents.id＋callIdごとのAbortController。他のsenderからは取り消せない、重複は拒否） | `desktop/callRegistry.ts`、`desktop/main.ts` |
| NDJSONの逐次読み（progressは決まった項目だけ残す、行・全体の長さに上限、途中切断・中断を区別） | `desktop/runtime.ts` |
| 画面の製品版経路（signal・onProgressがあればcallIdを付け、中断でmainへ取り消しを送ってAbortError） | `src/editor/apiTransport.ts` |
| 製品版のNDJSONのエラーを通常のrouteと同じ方針で秘匿（利用者向けでない例外は「内部エラーが発生しました」） | `server/app.ts` |
| 閉じる操作の`drain`は、AI操作が進行中なら待たずに`busy: true`を返す（「処理が実行中です」を出す） | `server/app.ts`、`server/desktop-worker.ts` |

## 決めたこと

- 進み具合のIPCは要求を出した画面（sender）にだけ送り、callIdで対応付ける。関数はIPCを越えられないため、購読はpreloadが持ち、結果が返ったら解除する。
- 取り消しはmainが内部APIへのfetchを中断し、workerは接続切れで処理を中断する。確認窓が出た後に画面で取り消した場合、確認窓は答えるまで残るが、承認されても送る直前の中断チェックで送信しない（既存の`askChatGPT`）。
- 閉じる操作中に`busy`だった場合、workerは受付を止めない。main側はclosing中の要求を受け付けないため、生成結果の保存は次の保存準備で行われる。

## 確認したこと

- 型チェック、全テスト（vitest、53ファイル・515件。`tests/desktopApp.test.ts`は/mnt/c上で`server/app`の読み込みが10秒を超えて前処理が時間切れになる既存の問題があったため、前処理の期限を60秒に延ばした）、`npm run desktop:build`（配布物検査を含む）。

## 未確認・残り

- Windows実機での通し確認：参考画像付きの生成で確認窓が出ること、進み具合の表示、取り消し、生成中に閉じようとしたときの「処理が実行中です」。
- 画面で取り消したときに、表示中の確認窓も閉じること（今は答えるまで残る）。
- 承認済みの送信のときだけ資格情報を渡すこと、作品revisionへの結び付け（前回からの持ち越し）。
