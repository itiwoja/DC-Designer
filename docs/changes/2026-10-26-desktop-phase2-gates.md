# 段階2の実装メモ：送信ゲートの仕上げと実機の通し確認（2026-10-26）

[段階2（画面からのAI操作）の実装メモ](./2026-10-26-desktop-phase2-ai-ops.md)などに残っていた段階2の残りを実装し、Windows 実機で段階1・2を通しで確かめた。実機確認で見つかった不具合もここで直した。

## 作ったもの

| 項目 | 場所 |
| --- | --- |
| 確認待ちの間に画面で取り消したら、worker が `ai-consent-cancel` を送り、main が確認窓を閉じて待ち行列から外す（承認後の取り消しは無視。行き違いで承認が届いたら worker が `ai-outcome: failed` を返す）。`API_PROTOCOL_VERSION` を 4 に | `server/ai-consent.ts`、`desktop/aiConsent.ts`、`desktop/runtime.ts`、`desktop/protocol.ts`、`desktop/main.ts` |
| ChatGPT の資格情報（`chatgpt/oauth`）は、ChatGPT を使う操作（操作表の `chatgpt: true`）の実行中だけ worker に渡す。他の provider の資格情報は渡さない（`SECRET_DENIED`） | `desktop/operations.ts`、`desktop/runtime.ts`、`server/secrets.ts` |
| 目的別 egress ゲート：製品版の worker の `fetch` を包み、既定拒否で許可表（fonts・auth・ai）に合うものだけ通す。`POST /v1/responses` は承認1回につき1回（60秒で失効）。リダイレクトは追わない | `server/egress.ts`、`server/desktop-worker.ts` |
| 対象作品（subject）：画面が保存済みの作品の `{ kind, id, title }` を AI 要求に付け、worker が検証して payload と hash に入れ、確認窓に「対象の作品」として出す | `src/editor/aiSubject.ts`、`src/editor/api.ts`、`server/request-parsers.ts`、`server/app.ts`、`desktop/aiPayload.ts`、`desktop/consentPreload.ts` |
| 確認を待つ間に同じ作品が編集されたら、返ってきた AI の結果を当てはめずに捨てる（製品版だけ） | `src/editor/aiSubject.ts`、`src/editor/App.tsx`、`src/editor/useDeck.ts` |

## 実機確認で見つけて直した不具合

| 症状 | 原因と直し方 | 場所 |
| --- | --- | --- |
| 編集した直後に閉じると「閉じる操作を中止しました（保存できていない内容があります）」になる | 閉じる途中（closing）は全要求を断っていたため、閉じる前の確定保存まで断っていた。操作表に `closeSave`（`posters.create`・`posters.update`）を足し、closing 中もそれだけ通す | `desktop/operations.ts`、`desktop/runtime.ts` |
| 生成中に閉じようとして「編集へ戻る」と、AI の結果が返ってこない（返答もエラーも出ない） | 起動状態の覆いが、ready とそれ以外で返す要素の並びを変えていたため、ready → closing → ready のたびにエディタ全体が付け直されていた。並びを固定し、覆いだけを出し入れする | `src/editor/DesktopRuntime.tsx` |
| 頼んでいない確認窓が出る | チャットの自動要約（ローリング要約）が裏で AI に送っていた。製品版では自動要約をしない（ユーザー回答。AI には直近のやりとりだけを渡す） | `src/editor/ChatLog.tsx` |
| ホーム右上に「OpenRouter」と出る／ホームからサインインできない | 未サインインのときの表示が開発版向けだった。製品版は「ChatGPT にサインイン」ボタンにし、既定のブラウザでのサインインを始める | `src/editor/Home.tsx` |
| チャット欄の「サインイン」が何も起きず、案内に `.env` が出る | 開発版のサインイン（別タブ）を呼んでいた。製品版は main のサインインを呼び、OpenRouter の案内を出さない | `src/editor/api.ts`、`src/editor/App.tsx` |
| 右パネルの「書き出し」がパネルからはみ出す | 既定の幅（304px）に収まらなかった。パネルが 380px 以下のときは文字を隠してアイコンだけにする | `src/editor/App.tsx`、`src/styles.css` |
| 確認窓に「画像 0 枚（合計 1 KB）」と出る | 0 枚のときも最小 1 KB で表示していた。0 枚は「なし」 | `desktop/consentPreload.ts` |

## 決めたこと

- 対象作品への結び付けは「軽め」（ユーザー回答）：作品の保存版（updatedAt）との照合はせず、確認窓への表示・hash への組み込みと、編集されたら結果を捨てることにとどめる。
- 資格情報の制限は「ChatGPT を使う操作の実行中」の単位で、承認より前のモデル一覧・トークン更新にも使えるようにした。外へ出せる先は egress ゲートで固定している。中断された操作は worker の後始末のため 3 秒だけ遅れて閉じる。

## 確認したこと

- 型チェック、全テスト（vitest）。
- Windows 実機（10.0.26200）で、使い捨ての `LOCALAPPDATA` を使った自動操作（Playwright の `_electron`）：
  - 段階1（22 件）：ホーム表示と `userRoot` の各領域、新規作成・編集・自動保存、通常終了、再起動後に内容が残る、サムネイル（画像化したプレビュー）、編集直後に閉じて保存されてから終了、二重起動で既存の窓が前に出る、終了後にプロセスが残らない。通常のパスと日本語・空白を含むパス（`テスト 用`）の両方。
  - 段階2（10 件、本物の ChatGPT に送信）：ホームからのサインイン、資格情報が DPAPI で暗号化され平文の token が無い、確認窓に送信先・本文・対象の作品、拒否で送らない、画面の取り消しで確認窓が閉じる、生成中に閉じると「処理が実行中です」、承認した 1 回の送信で結果が当てはまる、頼んでいない確認窓が出ない、終了後にプロセスが残らない。
- 確認用のスクリプトは `%LOCALAPPDATA%\Temp\dcd-verify\`（`verify.mjs`・`ai.mjs`・`lib.mjs`）。リポジトリには入れていない。

## 未確認・残り

- NSIS インストーラーの作成・導入・アンインストール（`desktop:dist`）。
- 段階1の受け入れ基準の残り：不正 Origin／Host、外部窓の IPC、レンダラーの直接通信の拒否を実機で試す。API 異常終了・main 強制終了からの復旧。
- 確認窓のキーボード操作・読み上げ、サインイン時のファイアウォールの表示。
- フォント取得（Google Fonts からの実取得・OS 登録）の実機確認（自動操作では初回の許可を「許可しない」で答えている）。
- 初回の確認で、ネイティブの閉じる要求（`CloseMainWindow`）が1回目に効かず、2回目で閉じたことがあった。再現していない。
