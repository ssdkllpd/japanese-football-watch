# D1 Phase 3 date index implementation v1.0

更新日: 2026-08-31

## 状態

Phase 2 R5の正式レビューPASSに基づき、Phase 3の最初の単位である日付別／大会別日付一覧のD1 read pathを実装した。初回実装後のCodex自己レビューで検出した5件も修正し、最終code HEADは`c5c5754`である。これは実装とローカル検証までであり、productionのflag変更、Worker deploy、正本切替は行っていない。

```text
Implementation: COMPLETE
Independent review: PENDING
Feature flags: OFF by default
Production cutover: NOT AUTHORIZED
```

## 対象endpointとrollback

| endpoint | D1 flag | 既定値 | rollback |
|---|---|---:|---|
| `GET /api/v2/dates/{date}` | `D1_DATE_INDEX_ENABLED` | `false` | flagを`false`へ戻す |
| `GET /api/v2/competitions/{competitionId}/dates/{date}` | `D1_COMPETITION_DATE_INDEX_ENABLED` | `false` | flagを`false`へ戻す |

2つのflagは独立している。flag未設定または`false`では既存R2 keyとresponse pathをそのまま使い、D1 bindingを読まない。standings、fixture detail、LIVE、tracking aggregatesには変更を加えていない。

## response-ready coverage

`migrations/0002_d1_date_index_coverage.sql`は次の2表を追加する。

- `date_index_coverages`: JST date全体の完全なR2 indexをD1 fixture ID集合と照合済みであることを表す。
- `competition_date_index_coverages`: competition/date単位の完全なR2 indexを同じ粒度のD1 fixture ID集合と照合済みであることを表す。

coverage rowの不在は明示的に`not migrated`であり、空日を意味しない。`fixture_count = 0`のcoverage rowだけが「取得・検証済みの空日」を表す。これにより未投入日を誤って`200 fixtures: []`にしない。

fixtureの`canonical_id`、`competition_season_id`、`date_jst`の実値更新、およびfixtureの追加・削除はcoverageをtriggerで失効させる。competition coverageはtriggerで明示削除し、FK cascadeも二重防御として残す。

### coverage plan

```json
{
  "schemaVersion": "d1-date-index-coverage-plan/1",
  "dateIndex": "artifacts/date-index.json",
  "competitionIndexes": [
    "artifacts/competition-date-indexes/af_competition_39.json"
  ]
}
```

artifact pathはplan fileのdirectory相対であり、`..`とsymlinkの両方によるdirectory脱出を拒否する。genericと各competition artifactは完全なdate-index contractで検証する。D1とのfixture ID集合照合、coverage upsert、competition coverage入替は同一`BEGIN IMMEDIATE` transaction内で行い、失敗時は既存coverageを含めて状態を変えない。

```bash
node scripts/d1/import-date-index-coverage.mjs \
  --database .tmp/d1/local.sqlite \
  --plan .tmp/d1/date-index-coverage-plan.json \
  --report .tmp/d1/date-index-coverage-report.json
```

reportは検証したdate、generic/competition fixture件数、各artifactのSHA-256を返すが、`productionReady`は常に`false`である。

## D1 read contract

- 日付一覧はcoverageとfixtureを1 queryで読み、`idx_fixtures_date_kickoff`を使用する。
- 大会別日付一覧はcompetition identity 1 queryとcoverage/fixture 1 queryの合計2 queryで、fixture queryは`idx_fixtures_competition_date_kickoff`を使用する。
- いずれも`EXPLAIN QUERY PLAN`で`fixtures`の全表走査がないことを回帰testで固定する。
- coverage件数、実際のfixture件数、fixture IDの一意件数が一致しなければ失敗する。
- 内部rowはそのまま公開せず、既存2.0 date indexと同じDTOへ投影する。
- scoreの明示的な`0`、欠落の`null`、winnerの`true` / `false` / `null`を区別する。D1 booleanは`0` / `1`以外、数値列は非負整数／`null`以外を受理しない。
- `generatedAt`はcoverage作成元R2 indexの検証済み時刻を使い、request時刻で上書きしない。
- fixture順は`kickoffUtc`、同時刻では`fixtureId`のcode-point順とする。
- D1成功応答は`x-jfw-data-source: d1`、TTL 300秒とする。

## 共有date-index contract

`shared/date-index-contract.mjs`をpublisher、merge、coverage importer、Worker degraded fallbackで共有する。次をfail closedで検証する。

- contract version、`Asia/Tokyo`、実在date、canonical UTC instant
- genericではroot competitionなし、competition scopeでは完全なroot competitionあり
- fixture/competition/season/team canonical ID
- status、ingestion state、team、winner、5種類のscore pair
- fixtureのdate/competition scope
- fixture ID一意性
- `kickoffUtc`、`fixtureId`による決定的順序

`scripts/v2/merge-date-index.js`はincomingとmerged artifactをこのcontractで検証し、competition-scoped artifactのroot `competition`を保持する。旧publisherが作ったroot欠落artifactも、次回の有効なincoming mergeで修復できる。

## Cache API

D1成功と検証済みdegraded成功だけを`caches.default`へ保存する。genericとcompetition/dateは別keyで、D1は300秒、degradedは60秒である。

- miss: `x-jfw-cache: miss`
- hit: `x-jfw-cache: hit`
- data source: `x-jfw-data-source: d1 | r2-degraded`

両headerはCORSの`Access-Control-Expose-Headers`へ追加した。origin検証とsoft rate limitはcache lookupより先に実行する。Cache APIのmatch/put失敗はresponse correctnessへ影響させない。

## missing coverageとdegraded fallback

| 条件 | response |
|---|---|
| flag ONだがcoverageなし | 既存R2 pathへ戻し、`x-jfw-data-source: r2-not-migrated`。既存のmissing/empty semanticsを維持 |
| D1 read失敗＋同じentityの完全なR2 snapshotあり | `200`、`degraded: true`、`lastSuccessfulAt`、`x-jfw-data-source: r2-degraded` |
| D1 read失敗＋R2 binding/objectなし、JSONまたはcontract不正 | `503`、`x-jfw-data-source: unavailable` |
| D1 query成功だがcompetitionが存在しない | `404`、`x-jfw-data-source: d1`。R2へfallbackしない |

degraded snapshotは共有contract全体を検証するため、別日・別大会だけでなく、team/score/status等が欠けたfixture DTO、重複ID、非決定的順序も成功として返さない。

## 検証証跡

実行環境: Node v22、`node:sqlite`のin-memory databaseへ`migrations/0001_d1_core.sql`と`0002_d1_date_index_coverage.sql`を適用。

```text
node --test tests/v2-worker.test.js
20 tests / 20 pass / 0 fail

node --test \
  tests/d1-date-index-coverage.test.js \
  tests/v2-date-index.test.js \
  tests/v2-date-feed.test.js
12 tests / 12 pass / 0 fail

node --test tests/*.test.js
279 tests / 277 pass / 0 fail / 2 todo

node --check worker/index.mjs
node --check scripts/d1/import-date-index-coverage.mjs
node --check shared/date-index-contract.mjs
pass

git diff --check
pass
```

TODO 2件はPhase 2から継続する既知のbackfill idempotencyであり、date index差分による追加ではない。

回帰testは少なくとも次を固定する。

- flag OFFでD1 read 0回
- dedicated index利用とfixture全表走査なし
- `0` / `false` / `null`保持
- exact coverage import、明示的空日、未移行日
- coverage validationのrollbackとfixture identity書込みによる自動失効
- publisherのroot competition保持と同時kickoffの決定的順序
- 完全DTOだけを許すsame-entity degraded fallback
- corrupt D1数値を`null`へ丸めないfail-closed動作
- edge cache hit/missおよびcache障害からの独立
- 未知competition 404で無関係なR2を読まないこと

## production cutover前の残作業

1. 本差分の独立レビューをPASSにする。
2. 対象環境へ`0002_d1_date_index_coverage.sql`を適用する。
3. canonical JSON/R2 bundle、Git補正定義、fixture catalog、適用済みD1、reconciled parity coverage、readiness plan v2を揃える。
4. 実R2 date/competition artifactをcoverage importerへ渡し、対象date全件のreportを保存する。
5. stagingでD1 failure injection、未移行日、明示的空日、Cache APIを実測する。
6. endpoint単位のsemantic shadow compareを開始し、切替後も最低7日間継続できる監視を用意する。
7. production flag変更について別途明示承認を得る。

上記が揃うまで2つのflagは`false`のままとし、production cutoverを行わない。
