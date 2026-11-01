# 10. ER 図 / シーケンス図 / 状態遷移図
- プロジェクト：DC-Designer 紹介サイト ／ 版数：v0.1（2026-11-01） ／ インプット：[03](03_use_cases.md)、[08](08_database.md)、[09](09_api.md)

> **3行で**
> 1. シーケンス図は 4 枚：リリース連動の公開・push での公開・ダウンロードと確認・ビルド失敗。
> 2. リリース連動は「タグ push → 配信 CI（承認つき）→ 完了 → サイトのワークフロー」の順で、配信 CI が失敗・却下されたらサイトは動かない。
> 3. 状態遷移があるのは媒体（`placeholder` → `ready`）だけ。

## 🧭 判断してほしいこと
なし

## 全体図
```mermaid
flowchart LR
  T[タグ push] --> RW[release-windows<br>承認・公開] -->|success| SW[site.yml] --> P[GitHub Pages]
  M[main へ push<br>site/・docs] --> SW
  RW -->|failure| X[サイトは動かない]
```
見てほしいところ：サイトの公開のきっかけは 2 系統（リリースと文面の変更）だけ。

## 要点
- ER 図は [08](08_database.md#全体図) と同じ（ここに再掲）。
- [リリース連動](#site-uc-005リリース連動でサイトを更新する) が最重要の流れ。
- [ビルド失敗](#例外ビルド失敗) では公開中のサイトが残る。

---

## 詳細

### ER 図
```mermaid
erDiagram
  RELEASE ||--|{ RELEASE_ASSET : has
  FEATURE ||--o| MEDIA : shows
  SITE_CONFIG ||--o{ POLICY : lists
```
フィールドは [08](08_database.md#テーブル一覧)。

### SITE-UC-005：リリース連動でサイトを更新する
```mermaid
sequenceDiagram
  actor O as 所有者
  participant RW as release-windows
  participant GR as GitHub Releases
  participant SW as site.yml
  participant API as GitHub API
  participant PG as GitHub Pages
  O->>RW: v1.0.7 タグを push
  RW->>O: production-release の承認を求める
  O->>RW: 承認
  RW->>GR: gh release create（exe・SHA256SUMS・latest.yml）
  RW-->>SW: workflow_run completed（success）
  SW->>API: SITE-API-001 GET releases
  API-->>SW: Release 一覧
  SW->>GR: SITE-API-002 GET SHA256SUMS.txt
  GR-->>SW: 値
  SW->>SW: astro build（検証つき）
  SW->>PG: deploy-pages
  PG-->>O: 公開完了（15 分以内）
```

### SITE-UC-006：文面を変えて公開する
```mermaid
sequenceDiagram
  actor O as 所有者
  participant GH as main
  participant SW as site.yml
  participant API as GitHub API
  participant PG as GitHub Pages
  O->>GH: site/** か docs/privacy.md を変えた PR をマージ
  GH-->>SW: push（paths に一致）
  SW->>API: SITE-API-001（版情報は毎回取り直す）
  API-->>SW: Release 一覧
  SW->>SW: astro build
  SW->>PG: deploy-pages
```

### SITE-UC-002：ダウンロードして確かめる
```mermaid
sequenceDiagram
  actor V as 閲覧者
  participant S as SITE-SCR-002
  participant GR as GitHub Releases
  participant W as Windows
  V->>S: ダウンロードページを開く
  S-->>V: 版・サイズ・署名状況・SHA-256
  V->>GR: SITE-API-004 exe をダウンロード
  GR-->>V: DC-Designer-Setup-1.0.6.exe
  V->>W: Get-FileHash で照合
  alt 一致
    V->>W: インストーラーを実行（未署名なら SmartScreen で「詳細情報」→「実行」）
  else 不一致
    V->>V: 実行しない・Issues か SECURITY.md の窓口へ
  end
```

### 例外：ビルド失敗
```mermaid
sequenceDiagram
  participant SW as site.yml
  participant API as GitHub API
  participant PG as GitHub Pages
  actor O as 所有者
  SW->>API: SITE-API-001
  API-->>SW: 503
  SW->>API: 再試行（1・2・4 秒）
  API-->>SW: 503
  SW->>SW: ビルド失敗「GitHub API の取得に失敗しました（HTTP 503）」
  Note over PG: 公開中のサイトはそのまま
  SW-->>O: Actions の失敗通知
  O->>SW: 復旧後に workflow_dispatch
```

### 状態遷移図：媒体（SITE-TBL-004）
```mermaid
stateDiagram-v2
  [*] --> placeholder: 枠を登録
  placeholder --> ready: 素材を置いて status を ready に
  ready --> ready: 素材を差し替え
```

## このドキュメントで決まったこと
- 新しい決定はなし（03・07・09 の決定を図にしたもの）
