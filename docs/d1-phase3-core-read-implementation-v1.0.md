# D1 Phase 3 Core Read implementation v1.0

更新日: 2026-08-31

この単位では、アプリの既存API contractを変えずに、standingsとfixture detailをD1から読める実装を追加した。既定flagはすべてOFFで、R2が即時rollback pathである。production D1への適用・flag変更・Worker deployはこの実装では行わない。

## 対象

| endpoint | flag | D1未移行時 | D1障害時 |
|---|---|---|---|
| `GET /api/v2/competitions/{competitionId}/seasons/{seasonId}/standings` | `D1_STANDINGS_ENABLED` | 同一seasonのR2 latest | 同一seasonの検証済みR2 degraded |
| `GET /api/v2/fixtures/{fixtureId}` | `D1_FIXTURE_DETAIL_ENABLED` | 同一fixtureのR2 pointer | 同一fixtureの検証済みR2 degraded |

standingsは`migrations/0003_d1_standings_publication.sql`と`import-standings.mjs`で、snapshot/group/row/publicationを1 transactionで登録する。publicationはrows/groups/snapshotの変更triggerで失効し、Workerは件数・identity digest・closed contractを再検証する。

fixture detailは既存`FixtureRepository`をWorkerから利用する。公開revisionがD1にあれば2.1 DTOを再構築し、detail archiveがR2に残るfixtureはD1のarchive metadata（key・sha256）を検証して読む。未知fixture、別fixtureのR2、壊れたJSONは誤entityへfallbackせずfail closedする。

## ローカル適用

```bash
node scripts/d1/create-current-fixed-snapshot.js \
  --output .tmp/d1/fixed-snapshot.json \
  --created-at 2026-08-31T00:30:00.000Z \
  --starts-on 2026-07-01 --ends-on 2027-06-30

node scripts/d1/import-fixed-snapshot.js \
  --input .tmp/d1/fixed-snapshot.json \
  --database .tmp/d1/local.sqlite \
  --manifest .tmp/d1/migration-manifest.json
```

新規DBでは上記CLIが`0001`〜`0003`を順番どおり適用する。既存の`0001` DBは、対象環境のmigration運用に従って`0002`、`0003`を一度だけ適用する。

standings artifactは、外部scope（competitionId/seasonId）とsource R2 keyをplanに明記してから次を実行する。

```bash
node scripts/d1/import-standings.mjs \
  --database .tmp/d1/local.sqlite \
  --plan .tmp/d1/standings-import-plan.json \
  --report .tmp/d1/standings-import-report.json
```

## 検証済み範囲

```text
node --test tests/*.test.js
298 tests / 296 pass / 0 fail / 2 todo
```

standingsは完全DTO parity、publication失効、transaction rollback、scope違いのR2拒否を固定した。fixture detailはD1 compact、R2 degraded、同一fixture identity検証、flag OFF時のD1バイパスを固定した。残るTODOはPhase 2から継続するbackfill idempotency 2件で、本単位の回帰ではない。

## 次の実作業

1. 実R2 standings/fixture bundleをplanへ登録し、ローカルD1へimportして件数・identity・semantic parity reportを保存する。
2. staging D1へ`0001`〜`0003`を適用し、4 endpointのfailure injectionとrows readを計測する。
3. 1回のまとめレビューでCore Read全体を確認する。
4. 明示承認後にのみstaging flagを変更する。production flagは別途承認されるまで変更しない。
