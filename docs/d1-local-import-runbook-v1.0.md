# D1 Phase 1 ローカル固定 snapshot import 手順 v1.0

## 目的

現行 backfill を first-pass で1回だけ適用した固定 snapshot を作り、レビュー済み D1 schema へローカル import する。既存 Worker/R2 の runtime 正本は切り替えない。

## 1. 固定 snapshot の生成

生成時刻と product season の境界は明示入力する。

```bash
node scripts/d1/create-current-fixed-snapshot.js \
  --output /tmp/jfw-fixed-snapshot.json \
  --created-at 2026-08-27T12:00:00.000Z \
  --starts-on 2026-07-01 \
  --ends-on 2027-06-30
```

生成物は次を含む。

- base JSON と全 fragment の canonical SHA-256
- first-pass merge 後の全データ
- snapshot内部payloadの `inputSha256`
- 生成artifact全体のcanonical SHA-256（CLI出力とmigration manifestの`inputSha256`）
- schema version、product season、生成時刻

同一入力・同一生成時刻では同じpayload hashとartifact hashになる。membership の完全重複、期間逆転・重複、player/record ID 重複、未知 player 参照、hash 不一致は生成または import 前に拒否する。

## 2. ローカル D1 互換 SQLite への import

```bash
node scripts/d1/import-fixed-snapshot.js \
  --input /tmp/jfw-fixed-snapshot.json \
  --database /tmp/jfw-local-d1.sqlite3 \
  --manifest /tmp/jfw-d1-migration-manifest.json
```

未作成 database には `migrations/0001_d1_core.sql` を適用する。import、FK/XOR、件数、provenance の検証は1 transaction内で行う。

- 同じcanonical artifact SHA-256の再実行は no-op。
- 異なる固定 snapshot の重ね掛けは拒否する。
- `0` と `null` は aggregate JSON 内でも区別して保持する。
- Core player/team を確定できない選手は `unresolved` / `ambiguous` と legacy membership で保持し、ダミー Core entityを作らない。
- crosswalk 解決時は `resolveTrackedPlayerCrosswalk` が全期間を Core membership へ付け替え、legacy 参照削除まで同じ transactionで行う。

## 3. fail-closed gate

現行 legacy `playerMatchStats` は完全な canonical fixture bundle ではない。provider IDや名称から不足事実を推測して Core fixture を作らず、固定 snapshot 内に保持したまま migration manifest の `deferred.legacyMatchRecords` に件数を記録する。

`deferred.legacyMatchRecords > 0` の間は `productionReady: false` である。これはローカル変換器の失敗ではなく、Phase 2 の canonical fixture bundle shadow compare 前に本番正本を切り替えないためのgateである。

## 4. 回帰確認

```bash
node --test tests/d1-fixed-snapshot-importer.test.js
node --test tests/*.test.js
```

Attention用3テーブル、`legacy.html`、現行Worker/R2経路はこの手順の対象外とする。
