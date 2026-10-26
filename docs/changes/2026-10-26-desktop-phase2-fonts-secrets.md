# 段階2（前半）の実装メモ：フォント取得と資格情報の保護（2026-10-26）

[段階分け](../desktop-release-spec.md#phases)の段階2のうち、フォント（EXE-FR-005）と資格情報のDPAPI保護の土台（EXE-FR-003）を実装した。AI送信確認（EXE-FR-004）と目的別egressゲートは次に設計・実装する。製品版のAI機能は無効のまま。

## 作ったもの

| 項目 | 場所 |
| --- | --- |
| 全文字入りTTFの取得・検証・キャッシュ（許可ホスト2つ、手動リダイレクト検証、Content-Type、32MiB上限、sfnt検査、sha256照合） | `server/font-cache.ts` |
| `/api/fonts/files`・`acquire`・`embed`（text不要）・`install`（製品版は`expect`必須、登録するbytesをhashで照合） | `server/fonts.ts`、`server/app.ts` |
| SVG書き出しの`@font-face`をAPIのTTFから作る、PPTX埋め込みで作品文字を送らない、製品版の画面表示をFontFaceで読む | `src/render/export.ts`、`src/fonts.ts`、`src/editor/api.ts` |
| 取得の初回許可（`<userRoot>/fonts/consent.json`）、OS登録のネイティブ確認、メニューからの許可取り消し | `desktop/fontGate.ts`、`desktop/main.ts` |
| main内部専用の操作（`fonts.acquire`。画面の操作表には載せず、workerの許可リストにだけ入れる） | `desktop/operations.ts`の`DESKTOP_INTERNAL_OPERATIONS` |
| safeStorage（DPAPI）による資格情報ストア、画面向けの`secrets.status/set/remove`（値は返さない） | `desktop/secrets.ts`、`desktop/bridge.ts`、`desktop/preload.ts`、`desktop/main.ts` |
| worker↔mainの資格情報の受け渡し（`API_PROTOCOL_VERSION`=2）、サーバー側の読み出し口 | `desktop/protocol.ts`、`desktop/runtime.ts`、`server/secrets.ts`、`server/desktop-worker.ts` |

## 決めたこと・設計から外れた判断

- **フォント取得の確認**：初回に1回だけ許可を取る（ユーザー回答）。以後は表示・書き出しに必要なfaceを自動取得する。拒否は保存せず次回また聞く。
- **画面の表示**：製品版は使っているweightに最も近いfaceだけを取る（日本語フォントは全weightで数十MBになるため）。画面UIの既定フォント（`index.html`のGoogle Fonts link）とフォールバックのNoto Sans JPは、製品版では引き続きOSのフォントで表示される。
- **workerが書き換えられる資格情報**は`chatgpt/oauth`（サインインで更新されるもの）だけ。APIキーは画面の設定からだけ変更できる。workerは`secret-get`で値を受け取れる（AI送信ゲートを入れるときに、渡す範囲を見直す）。
- **ライセンス表示**：カタログにフォントごとのライセンス情報が無いため、OS登録の確認には固定文（Google Fonts、SIL Open Font License等）を出す。
- `authStatus`・`startLogin`・`aiProvider`・`askAI`はasyncになった。

## 確認したこと

- 型チェック、全テスト（vitest）。
- 単体テストで確認したこと：許可外ホスト・http・許可外へのリダイレクト・Content-Type不正・上限超過・壊れたsfntの拒否、キャッシュ命中で通信しないこと、hash不一致での再取得、installの`expect`不一致で登録しないこと、初回許可が同時要求でも1回だけ出ること、暗号化不可・復号失敗での`reauthRequired`と平文を残さないこと、workerからAPIキーを書き換えられないこと。

## 未確認・残り

- Windows実機での確認：実際のGoogle Fontsからの取得（日本語フォントのサイズが32MiB以内か、書き出しファイルの大きさ）、ダイアログの表示、OS登録、safeStorageの暗号化と復号。
- 設定画面（EXE-SCR-004）、AI送信確認（EXE-SCR-002、EXE-API-003/004）、目的別egressゲート。
