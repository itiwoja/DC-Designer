# DC-Designer

ポスターとスライドを、**レイヤーを重ねた設計図（JSON）** として AI に組み立てさせるツール。
1枚の生成画像ではないので、Illustrator / PowerPoint のようにあとからレイヤー単位で直せる。

```
ブリーフ(+参考画像) → AI が設計図(JSON)を作る → 画像を1点ずつ生成 → エディタで調整 → 書き出し
```

| 作るもの | 書き出し |
| --- | --- |
| ポスター | PDF / PNG / SVG / JSON |
| スライド | PowerPoint（PPTX）/ JSON |

## はじめかた

```bash
npm install
cp .env.example .env   # 使う AI のキーを入れる（無くても動く）
npm run dev            # http://localhost:5173
```

- **キーが無くても**: 白紙からの編集・書き出しはできる。画像はダミー表示になる
- **レイアウト生成・AI 修正**: エディタ左下の「ChatGPTでログイン」（Plus / Pro が必要）か、`.env` に `OPENROUTER_API_KEY`
- **画像生成**: `OPENAI_API_KEY` / `GEMINI_API_KEY`、ローカルの ComfyUI、Codex CLI のどれか

詳しい設定 → [セットアップと AI の設定](./docs/setup.md)

## できること

- **AI で作る**: ブリーフや参考画像・PDF から、レイアウトと画像をまとめて生成
- **チャットで直す**: 「見出しを大きく」のように頼むと、AI がレイヤーを書き換える（元に戻せる）
- **参考画像の再現**: 見本の画像をできるだけそのまま写し取る（A4 のみ）
- **PowerPoint / PDF を開いて編集**: 既存の .pptx や PDF をレイヤーに分解して読み込む
- **発表まで**: アニメーション・台本（ノート）・発表者ビュー

操作方法・ショートカット・書き出しの仕様 → [使い方](./docs/usage.md)

## ドキュメント

| 読みたいこと | ページ |
| --- | --- |
| API キー・ChatGPT・OpenRouter・ComfyUI の設定 | [docs/setup.md](./docs/setup.md) |
| 画面・エディタ操作・成果物管理・PPTX・書き出し | [docs/usage.md](./docs/usage.md) |
| ファイル構成・API・拡張のしかた | [docs/development.md](./docs/development.md) |
| Windows 版（exe）の設計と配布 | [docs/README.md](./docs/README.md) / [配布・更新ポリシー](./docs/release-policy.md) |
| プライバシー | [docs/privacy.md](./docs/privacy.md) |

## Windows 版

インストーラーは GitHub Releases で配布。起動のたびに更新を確認し、新しい版があればアプリ内で案内する。
コード署名は SignPath の審査待ちで、それまでは未署名で公開している。

```bash
npm run desktop:dist   # インストーラーをビルド
```

## ライセンス

[MIT License](./LICENSE)
