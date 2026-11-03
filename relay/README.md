# 要望・不具合の中継（Cloudflare Worker）

GitHub のアカウントが無い利用者の要望・不具合を、GitHub App（Bot）のトークンで GitHub の Issue にする中継です。

```
画面 → アプリのサーバー POST /api/feedback → この中継 POST /v1/issues → GitHub REST API
```

- 受け付けるのは `POST /v1/issues` だけです。本文は JSON で 32KB までです。
- 検証は `desktop/feedbackRelay.ts` の `parseFeedbackRequest` を使います（アプリのサーバーと共通）。
- IP ごと（`PER_IP`、IPv6 は /64 ごと）と全体（`GLOBAL`）のレート制限があります。数値は `wrangler.jsonc` の `ratelimits` で変えます。Rate Limiting は Cloudflare の拠点ごとに数えるため、`GLOBAL` も拠点ごとの上限です。
- Issue には `from-app` と種類のラベル（enhancement / bug / question）が付きます。本文と件名の `@` メンションは無効にします。
- CORS は付けません。ブラウザからは呼びません。

## 先に用意するもの

1. 起票先リポジトリ（itiwoja/DC-Designer）に `from-app` ラベルを作ります。無いと Issue の作成に失敗します。
2. GitHub App を作ります。Issue の作成者が `<App名>[bot]` になります。
   - GitHub の Settings → Developer settings → GitHub Apps → New GitHub App
   - Homepage URL はリポジトリ（`https://github.com/itiwoja/DC-Designer`）にします。
   - Webhook の Active は外します。
   - Repository permissions は `Issues: Read and write` だけにします（`Metadata: Read` は自動で付きます）。
   - Where can this be installed は「Only on this account」にします。
3. 作成後、ページに出る App ID を控えます。
4. 同じページの Private keys で「Generate a private key」を押し、`.pem` をダウンロードします。GitHub が配るのは PKCS#1 形式なので、PKCS#8 に変換します。

```
openssl pkcs8 -topk8 -nocrypt -in <ダウンロードした.pem> -out key-pkcs8.pem
```

5. 左メニューの Install App から、`itiwoja/DC-Designer` だけを選んで入れます。入れた後の設定ページの URL の末尾の数字（`.../installations/<数字>`）が Installation ID です。
6. 3 つの値を Worker のシークレットに入れます（リポジトリには書きません）。

```
npx wrangler secret put GITHUB_APP_ID --config relay/wrangler.jsonc
npx wrangler secret put GITHUB_APP_INSTALLATION_ID --config relay/wrangler.jsonc
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config relay/wrangler.jsonc < key-pkcs8.pem
```

7. 変換後の鍵ファイル（`key-pkcs8.pem`）とダウンロードした `.pem` は、入れたら消します。
8. 以前の PAT 方式から移すときは、旧シークレットを消し、GitHub の Settings で PAT も削除します。

```
npx wrangler secret delete GITHUB_TOKEN --config relay/wrangler.jsonc
```

トークンは Worker の中で作ります。App の JWT で `access_tokens` を呼び、`DC-Designer` の `issues: write` だけに絞ったインストールトークンを取って、期限の 5 分前まで使い回します。

## デプロイ

```
npx wrangler deploy --config relay/wrangler.jsonc
```

公開先は `https://dc-designer-feedback.<アカウントのサブドメイン>.workers.dev/v1/issues` です。`desktop/feedbackRelay.ts` の `FEEDBACK_RELAY_HOST` と合っているか確かめてください。

公開せずにビルドだけ確かめるときは次を使います。

```
npx wrangler deploy --dry-run --config relay/wrangler.jsonc --outdir <出力先>
```

## 応答

| 状況 | status | error |
| --- | --- | --- |
| 作成できた | 201 | （`{number, url}`） |
| 内容が正しくない | 400 | invalid |
| 他の path / method | 404 / 405 | invalid |
| JSON でない / 大きすぎる | 415 / 413 | invalid |
| レート制限 | 429 | rate_limited |
| GitHub に送れない・App の設定が無い | 502 / 503 | unavailable |

GitHub のエラー本文は応答に出しません。ログには status だけを残します。
