# D1 Phase 3 Core Read implementation v1.0

更新日: 2026-09-02

この単位では、アプリの既存API contractを変えずに、standingsとfixture detailをD1から読める実装を追加した。既定flagはすべてOFFで、R2が即時rollback pathである。production D1への適用・flag変更・Worker deployはこの実装では行わない。

## 対象

| endpoint | flag | D1未移行時 | D1障害時 |
|---|---|---|---|
| `GET /api/v2/competitions/{competitionId}/seasons/{seasonId}/standings` | `D1_STANDINGS_ENABLED` | 同一seasonのR2 latest | 同一seasonの検証済みR2 degraded |
| `GET /api/v2/fixtures/{fixtureId}` | `D1_FIXTURE_DETAIL_ENABLED` | 同一fixtureのR2 pointer | 同一fixtureの検証済みR2 degraded |

standingsは`migrations/0003_d1_standings_publication.sql`と`import-standings.mjs`で、snapshot/group/row/publicationを1 transactionで登録する。publicationはrows/groups/snapshotの変更triggerで失効し、Workerは件数・identity digest・closed contractを再検証する。

fixture detailは既存`FixtureRepository`をWorkerから利用する。公開revisionがD1にあれば2.1 DTOを再構築し、detail archiveがR2に残るfixtureはD1のarchive metadata（key・sha256）を検証して読む。未知fixture、別fixtureのR2、壊れたJSONは誤entityへfallbackせずfail closedする。R2の通常・degraded経路は、`fixture-dto.js`の実生成形状から生成した`shared/fixture-detail-contract.mjs`でrootとnestedの未知fieldを拒否する。2.0 artifactだけは、当時存在しなかったroot `detailAvailability`をoptionalとして維持する。

fixture degraded応答の`lastSuccessfulAt`は`fixture.reconciledAt`を使用する。date index / standingsの`generatedAt`が集合またはsnapshotを生成した時刻であるのに対し、これは**同一fixture revisionを最後に照合・公開した時刻**を意味する。

## 継続移行経路

standings、単一fixture、日付feedの各publisherは、R2公開完了後にのみD1 admin ingestを呼び出せる。D1 mirrorは`D1_ADMIN_PUBLISH_ENABLED == 'true'`に加えて`d1-staging` environmentを要求する別jobであり、R2/API取得jobへadmin tokenを渡さない。

6本のstaging書込みworkflowは、job開始後に解決されたD1 database name/UUID、admin Worker名、R2 bucket名、admin URL originを`config/d1-targets.json`のreview済み値とexact matchしてから書き込む。命名規則や`staging`部分一致をidentity proofには使わない。manifestにはCloudflare Dashboardで確認したD1 database name/UUID、R2 bucket名、Workers account subdomainと、staging provisionが作成するadmin Worker名および決定論的な`workers.dev` originを固定している。`verify-d1-target.mjs`は1項目でも不一致なら書込み前にhard failする。admin Workerの配備、secret、GitHub environment、flagは本実装では作成・変更していない。

fixture revisionはR2を権威とする。取得時刻だけの差はrevisionを増やさず保存済みR2 bytesを維持し、実内容が変わった場合だけ増分する。D1初回移行時はR2 revisionが1より大きくても保持し、既存D1最大revision以下の巻き戻しだけを拒否する。

admin ingest planは処理失敗後の依存requestを送らず、再実行時は完了済みpublishを冪等に再検証する。最終`migration_verify`は書込みplanから自動導出しない`expectedTotals`を必須とし、完全移行を主張するplanではD1全体件数と照合する。増分publisherは`expectedTotals: null`を明示し、完全性を主張しない。

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

対象code commit: `11db9dc020557ecae477f25cc24771efc9518a1d`

```text
node --test tests/*.test.js
343 tests / 341 pass / 0 fail / 2 todo
```

standingsは完全DTO parity、publication失効、transaction rollback、scope違いのR2拒否を固定した。fixture detailはD1 compact、R2 degraded、同一fixture identity検証、flag OFF時のD1バイパスを固定した。加えて、R2-authoritative revisionの欠番移行、取得時刻だけのrevision不変、外部宣言totalの不一致、admin clientのfail-fast、3 publisherのsecret分離、fixed snapshotとdate coverageのrollback・retryを固定した。残るTODOはPhase 2から継続するbackfill idempotency 2件で、本単位の回帰ではない。

## 次の実作業

1. ここまでのCore Read、admin ingest、継続publisherを1回のまとめレビューで確認する。
2. レビューPASS後にCloudflare staging環境を作成し、`0001`〜`0003`を適用する。
3. 実R2 artifactをadmin ingestへ渡し、完全件数宣言、identity、semantic parity reportを保存する。
4. stagingで4 endpointのfailure injectionとrows readを計測する。
5. 明示承認後にのみstaging flagを変更する。production flagは別途承認されるまで変更しない。
