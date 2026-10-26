# 段階1の実装メモ（2026-10-26）

[段階分け](../desktop-release-spec.md#phases)の段階1（社内確認用）の実装状況と、設計書から外れた判断。正式配信はしない。

## 範囲

- **ローカル編集だけ**の版。製品版では AI 生成・AI 修正・フォント提案／埋め込み／OS 登録・ChatGPT サインイン・画像生成・Codex・ComfyUI を呼べない（`desktop/operations.ts` の静的操作表に載せず、worker 側も許可リスト外を 404 `DESKTOP_UNAVAILABLE`）。AI 送信確認と一緒に段階2で入れる。
- 開発版（`npm run dev`）の動作は変えていない。

## 作ったもの

| 項目 | 場所 |
| --- | --- |
| Electron main・`app://dc-designer`・セッションの通信阻止・窓の遷移制限 | `desktop/main.ts`、`desktop/appProtocol.ts` |
| 限定 IPC（EXE-API-009 の静的操作表）・preload | `desktop/operations.ts`、`desktop/bridge.ts`、`desktop/preload.ts` |
| utilityProcess の API worker・token／Host／Origin 照合・health | `desktop/runtime.ts`、`desktop/protocol.ts`、`server/desktop-worker.ts`、`server/app.ts` |
| 名前付きパイプ lease | `server/lease.ts` |
| 通常終了の保存調停 | `desktop/close.ts`、`src/editor/desktop.ts`、`src/editor/useAutoSave.ts` |
| 起動・復旧の表示（EXE-SCR-001） | `src/editor/DesktopRuntime.tsx` |
| iframe サムネイル → 受動的な描画 snapshot（SVG を Blob URL の `<img>` で表示） | `src/render/snapshot.ts`、`src/editor/ui.tsx` |
| 許可リストの隔離ビルド・配布物検査 | `scripts/build-desktop.mjs`、`scripts/inspect-desktop.mjs`、`electron-builder.yml` |

固定した版：electron 44.7.0、electron-builder 26.17.0、esbuild 0.28.2。

## 設計から外れた判断（段階2以降で見直す）

- **生成・取り込み画像**：設計は「IPC で確認した当該作品の bytes を Blob URL で表示」。段階1は暫定で、main が `app://dc-designer/generated/<file>` を `<userRoot>/assets/generated` から直接読んで返す（ファイル名・拡張子を検証。API への HTTP 中継はしない）。
- **画面のフォント**：Google Fonts は CSP とセッションで止めているため、画面とサムネイルは OS にあるフォントで表示される。フォントの同梱・取得は段階2。
- **利用者 SID**：lease 名は SID の代わりに `USERDOMAIN\username` から作る（子プロセスなしで SID を取れないため）。
- **lease 待ちの期限**：main の監視は worker の lease 期限（30秒）に5秒を足す（起動監視の30秒と競合しないように）。
- **CSP**：`index.html` のテーマ決定 inline script だけ、配信時に sha256 を計算して許可する（`unsafe-inline` は使わない）。
- **配布物**：worker は `asarUnpack` で asar の外に置く（utilityProcess で ESM を asar から読めるかは未確認のため）。`files` で `node_modules` を明示的に外す（外さないと electron-builder が上位ディレクトリの node_modules を拾い、検査で 5,000 件超の混入として検出された）。

## 確認したこと

- 型チェック、全テスト（vitest）。
- Windows（10.0.26200）の Node で、名前付きパイプ lease の取得 → 二重取得の待機・期限切れ → 解放後の取得。
- Windows で `electron-builder --win --dir` → 配布物検査（210 ファイル）→ exe を起動してホーム画面の表示、lease の保持、`%LOCALAPPDATA%/DC-Designer/` の作成 → 窓を閉じて0.5秒で終了し、プロセスとパイプが残らないこと。

## 未確認・残り

- 製品版での編集・保存・取り込み・書き出し・サムネイルの実操作、編集中に閉じたときの保存、API 異常終了・main 強制終了からの復旧、二重起動、日本語・空白を含むパス。
- NSIS インストーラーの作成・導入・アンインストール（`desktop:dist`）。
- 段階1の受け入れ基準（[spec](../desktop-release-spec.md#受け入れ基準)）の残り：不正 Origin／Host、外部窓の IPC、レンダラーの直接通信の拒否を実機で試す。
