# 04. コンポーネント
> 版：v0.1（2026-11-01）｜ 関連：[03_tokens](03_tokens.md)・[05_screens](05_screens.md)

> **3行で**
> - 部品は今のサイトにあるものだけ。新しく足したのは「図形の印」「群青の帯」。「ヒーローの図形」（CMP-006）は 2026-11-01 に廃止し、粒の演出（MOT-005）に置き換えた。
> - すべての操作部品に focus-visible を持たせ、タップ領域は 44px 以上。
> - アイコンは使わない。「⚠」も山吹の▲に置き換える（UI-D-25）。

## 🧭 判断してほしいこと
なし

## 全体図
```mermaid
flowchart TD
  subgraph 全ページ
    C1[CMP-001 スキップ] --- C2[CMP-002 ヘッダー] --- C11[CMP-011 フッター]
    C3[CMP-003 ボタン] --- C4[CMP-004 リンク]
  end
  subgraph トップ
    C7[CMP-007 機能カード] --> C5[CMP-005 図形の印]
    C15[CMP-015 媒体の枠]
    C14[CMP-014 群青の帯]
  end
  subgraph ダウンロード・履歴
    C8[CMP-008 注意] --> C5
    C9[CMP-009 パネル・表] --- C10[CMP-010 SHA-256] --- C12[CMP-012 コピー]
    C13[CMP-013 版カード]
  end
```
見てほしいところ：●▲■（CMP-005）は 3 つの部品から使われる共通の飾り。

## 要点
- ボタンは 4 種：主（群青）・帯の上（白地に群青の文字）・ゴースト（群青の縁）・小。1 画面に主は 1 つ。
- カードは影なし・縁 1px。主要機能カードだけ薄い色面と●▲■の印を持つ。
- 図形は CSS のクラスで描く（`style` 属性は CSP で止まるので使わない）。
- 操作部品の縁は `--color-border-control`（3:1 以上）。

---

## 詳細

### CMP-001 スキップリンク
「本文へ移動」。フォーカスされたときだけ左上に出る。地 `--color-action`・文字 `--color-on-action`・角丸 `--radius-button`・`--z-skip`。

### CMP-002 ヘッダーとメニュー
| 項目 | 仕様 |
|---|---|
| 地・縁 | `--color-surface`、下に 1px `--color-border` |
| 高さ | 64px（今は 56px：UI-D-34） |
| ロゴ | アプリのアイコン 28px＋「DC-Designer」（`--font-display`・`--weight-display`） |
| ナビ | 768px 以上：横並び（機能・更新履歴・GitHub）。未満：「メニュー」ボタン（`details`）に畳む |
| メニューボタン | 縁 `--color-border-control`・角丸 `--radius-button`・高さ 44px |
| 現在地 | 今いるページのナビ項目に 3px の群青の下線＋`aria-current="page"` |

| 状態 | 見た目 |
|---|---|
| 通常 | 墨の文字 |
| hover | 下線（太さ 2px） |
| focus-visible | `--focus-ring`（`--color-focus`） |
| 開いた（メニュー） | 白い板が下に出る。縁 `--color-border`・角丸 `--radius-card`・`--z-menu`。動きなし |

### CMP-003 ボタン
| バリエーション | 地 | 文字 | 縁 | 使う所 |
|---|---|---|---|---|
| 主 | `--btn-bg` | `--btn-fg` | なし | ヒーロー・ダウンロードページ・ヘッダー |
| 帯の上 | `--color-surface` | `--color-action` | なし | CMP-014 |
| ゴースト | 透明 | `--color-action` | 1px `--color-action` | コピー・404 の副・ヒーローの「機能を見る」（大。主ボタンの数に数えない：UI-D-48） |
| 小 | 主と同じ | 同じ | — | ヘッダー（ナビ扱い。主ボタンの数に数えない：UI-D-33） |

| サイズ | 高さ | 横の余白 | 文字 |
|---|---|---|---|
| 大 | 56px | `--space-6` | `--text-lg`・`--weight-bold` |
| 中 | 48px | `--space-5` | `--text-base` |
| 小 | 44px | `--space-4` | `--text-sm` |

| 状態 | 見た目 |
|---|---|
| 通常 | 上の表 |
| hover | 地が `--btn-bg-hover`、2px 上がる（[MOT-001](06_motion.md#mot-001)）。帯の上とゴーストは地が `--color-tint-square`（群青の文字 5.14:1） |
| active | 上がった分が戻る（0px） |
| focus-visible | `--focus-ring`（帯の上は `--color-focus-on-band`） |
| disabled | 使わない（ダウンロード先は常にある） |
| loading | 不要（ただのリンク） |

### CMP-004 リンク
文字 `--color-action`、下線あり（`text-underline-offset: 0.2em`）。hover で `--color-action-hover`＋下線 2px。外部リンク（GitHub）は文字の後ろに「→」。

### CMP-005 図形の印
| 図形 | 色 | 作り方 |
|---|---|---|
| ● | `--color-shape-circle` | 円（角丸 50%） |
| ▲ | `--color-shape-triangle` | 三角（`clip-path`） |
| ■ | `--color-shape-square` | 四角 |

サイズは `--shape-size-mark`（見出しの左に 1 つ。墨の 1px 縁つき：UI-D-36）と `--shape-size-hero`（縁なし。いまは 404 だけ）。飾りなので `aria-hidden="true"`。h2 の印はページ内で ●→▲→■ の順に回す。

### CMP-006 ヒーローの図形（廃止 2026-11-01）
CSS で描いた大きな●▲■はやめた。ヒーローの●▲■は粒（canvas）が集まって作る（[MOT-005](06_motion.md#mot-005)・UI-D-44）。ID は使い回さない。

### CMP-007 機能カード
| バリエーション | 中身 | 見た目 |
|---|---|---|
| 大（主要 3 つ） | 画像・見出し・説明 2 行・exe 版の注意 | 画像の背面に薄い色面（1 枚目 `--color-tint-circle`、2 枚目 `-triangle`、3 枚目 `-square`）、見出しの左に対応する●▲■ |
| 小（残り 4 つ） | 小さな画像（16:10）・見出し・説明 1〜2 行・exe 版の注意 | 白地・縁 1px・図形なし |

共通：地 `--card-bg`・縁 `--card-border`・角丸 `--card-radius`・影なし。カード自体はリンクではないので hover なし。スクロールで出る（[MOT-003](06_motion.md#mot-003)）。

### CMP-008 注意
| バリエーション | 使う所 | 見た目 |
|---|---|---|
| 強い注意 | 「この版はコード署名をしていません」 | 地 `--color-notice-bg`・左に▲（`--color-shape-triangle`、墨の 1px 縁つきで薄い地の上でも形が見える）・太字 |
| 弱い注意 | （今は使っていない。機能カードの制限は ※ の注釈：UI-D-37） | 地 `--color-notice-bg`・`--text-sm`・▲なし |

意味は文字で伝え、▲は飾り（`aria-hidden`）。「⚠」の絵文字は使わない。

### CMP-009 パネル・表
パネル：地 `--color-surface`・縁 1px・角丸 `--radius-card`・内側 `--space-6`。見出しの左に CMP-005 の小さな印。メタ（公開日・サイズ）は `--color-text-muted`・`--text-sm`。
表：縁 1px `--color-border`、見出し行の地 `--color-bg`、狭い画面では横スクロールの枠に入れる。

### CMP-010 SHA-256・コマンドの枠
地 `--color-code-bg`・縁 1px・角丸 `--radius-sm`・`--font-mono`。値は全選択できる（`user-select: all`）。

### CMP-011 フッター
地 `--color-surface`・上に縁 1px。リンク 5 つを横並び（折り返しあり）。右端に●▲■を小さく 1 列（飾り）。

### CMP-012 コピーボタン
ゴーストの小ボタン（CMP-003）＋状態の文。

| 状態 | 表示 |
|---|---|
| 通常 | 「コピー」 |
| 成功 | 文「コピーしました」（`--color-text`）を 2 秒出す。`role="status"` |
| 失敗 | 文「コピーできませんでした。値を選んでコピーしてください」（`--color-danger-text`） |
| focus-visible | `--focus-ring` |

### CMP-013 版カード（更新履歴）
パネル（CMP-009）と同じ形。見出しは版番号（`--font-display`）＋日付（`--color-text-muted`）。最新の版に「最新」バッジ（地 `--color-badge-bg`・文字 墨・角丸 `--radius-pill`）。古い版は `details` で畳む。開閉に動きはない。

### CMP-014 群青の帯
地 `--color-band`・文字 `--color-on-action`・上下 `--section-y`。中に見出し 1 行と「帯の上」ボタンだけを置き、図形は置かない（UI-D-37）。

### CMP-015 媒体の枠
画像・動画の枠。縁 1px・角丸 `--radius-card`・縦横比を先に決める（ヒーロー 16:10、機能 16:10、デモ 16:9）。素材が揃うまでは今の「準備中」の仮の画像（灰色）をそのまま使う。
ヒーローの画面画像は、粒の帯の外（すぐ下）に中央寄せ・最大幅 960px で置く。最初の画面の外に出るので `loading="lazy"` にし、先読みしない（UI-D-49）。
