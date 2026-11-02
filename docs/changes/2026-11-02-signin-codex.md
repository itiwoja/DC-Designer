# ChatGPT へのサインインで画像生成（Codex）も続けて準備する（2026-11-02）

決定者：ユーザー（EXE-D-15）

## なぜ

製品版で「ChatGPT にサインイン」しても画像を作れず、仮の画像になっていた。アプリの ChatGPT ログインのトークンは
`image_generation` ツールを `subscription_sharing_unsupported_capability` で拒否されるため、画像は Codex CLI 経由で作っている
（[2026-11-01](./2026-11-01-desktop-imagegen.md)）。Codex CLI のサインイン（`~/.codex/auth.json`）は別に要るが、そのことが画面から分かりにくかった。

## 何を変えたか

- ChatGPT へのサインインが `signed-in` で終わったら、`codexSetup.ensure()`（`src/editor/codexSetup.ts`）が `/api/status` を読み直して続ける。
  - Codex CLI が見つかって未サインイン → `codex login` を始める
  - 見つからず入れられる PC → 固定版を裏で取ってきて、続けて `codex login`
  - 使える・入れられない PC・状態が読めない → 何もしない
- `no-plan`・失敗・取り消しでは続けない。アカウント欄・AI 機能の案内のどちらから始めたサインインでも、`DESKTOP_ACCOUNT_CHANGED` を
  アカウント欄（`DesktopAccountBar`）が受けて続ける。
- 準備のあいだ、左下のアカウントのボタンに「画像生成を準備中…」「Codex にサインイン中…」を出す。進み具合と中止は設定の吹き出しの Codex 欄に出る（既存）。
- Codex のサインインの案内に「AI 機能と同じアカウントを選んでください」を足した（同じアカウントかは確かめない）。
- 画像生成を選んでいないときの既定を、起動しているか分からない ComfyUI より Codex を先にした（`src/editor/App.tsx`）。

## 採らなかったもの

- アプリの ChatGPT ログインのトークンから `~/.codex/auth.json` を作る：クライアントとスコープが違い、Codex CLI は自分のクライアントで
  トークンを更新するので動かない。このためブラウザでの認可は 2 回になる。

## 既知の制限

- 「別のアカウントでサインイン」をしても、Codex が既にサインイン済みなら Codex 側のアカウントは変わらない。
- ログアウトは利用者の `~/.codex/auth.json` に触れない（利用者が他で使う Codex CLI のサインインを消さないため）。
- Windows 実機での確認は未実施。
