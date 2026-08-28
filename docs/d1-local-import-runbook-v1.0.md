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

### Phase 2 coverage manifest

固定 snapshot の全 legacy match record を、provider fixture ID の有無・競合と canonical bundle の準備状況で機械分類する。

```bash
node scripts/d1/create-fixture-coverage-manifest.js \
  --input /tmp/jfw-fixed-snapshot.json \
  --output /tmp/jfw-d1-fixture-coverage.json
```

provider fixture ID が確認できても、固定 snapshot 自体は完全な canonical fixture bundle を含まないため、該当行は `provider_fixture_verified` かつ `importState: "deferred"` とする。ID 不足・複数IDの競合も推測で解決しない。coverage manifest は全recordを一度ずつ収録し、canonical bundle importが別Issueで完了するまで常に `productionReady: false` とする。

### Phase 2 semantic shadow compare

canonical bundle のJSON/R2経路とD1経路を同じfixture単位で比較する。2.0.0 bundleは2.1.0へ安全にupcastし、UTC表記・object key・配列順を正規化する。一方、`null`、明示的な`0`、fieldの欠落、section presence、補正状態は同一視せず差分として残す。

```bash
node scripts/d1/compare-fixture-shadow.js \
  --json /tmp/json-fixture.json \
  --d1 /tmp/d1-fixture.json \
  --report /tmp/jfw-d1-shadow-report.json
```

意味的同値なら終了コード`0`、差分があれば機械可読なJSON Pointer付きreportを出力して終了コード`1`とする。未対応contract versionは比較せずfail closedにする。

複数fixtureをCIまたは管理ジョブで一括比較する場合は、plan fileにcanonical fixture IDと両artifactの相対pathを列挙する。

```json
{
  "schemaVersion": "d1-fixture-shadow-plan/1",
  "fixtures": [
    {
      "fixtureId": "af:fixture:9001",
      "jsonPath": "json/9001.json",
      "d1Path": "d1/9001.json"
    }
  ]
}
```

```bash
node scripts/d1/compare-fixture-shadow-batch.js \
  --plan /tmp/shadow/plan.json \
  --report /tmp/shadow/report.json
```

全件同値の場合だけbatch reportの`passed`が`true`になる。差分、読込失敗、planとartifactのfixture ID不一致はfixtureごとに収集し、1件でもあれば終了コード`1`とする。`passed`はplan内比較の結果であり、本番切替の`productionReady`を意味しない。

## 4. 回帰確認

```bash
node --test tests/d1-fixed-snapshot-importer.test.js
node --test tests/d1-fixture-coverage.test.js
node --test tests/d1-fixture-shadow-compare.test.js
node --test tests/d1-fixture-shadow-batch.test.js
node --test tests/*.test.js
```

Attention用3テーブル、`legacy.html`、現行Worker/R2経路はこの手順の対象外とする。
