# D1 Phase 3 date index implementation v1.0

更新日: 2026-08-31

## 状態

Phase 2 R5の正式レビューPASSに基づき、Phase 3のCore Read（standings、fixture detailを含む）を段階導入している。日付一覧の修正済みcode HEADは`a173d44`、追加実装は`feat/d1-phase3-core-reads`である。これは実装とローカル検証までであり、productionのflag変更、Worker deploy、正本切替は行っていない。

```text
Implementation: COMPLETE
Independent review R1: CHANGES_REQUIRED
Independent review R2: PENDING
Feature flags: OFF by default
Production cutover: NOT AUTHORIZED
```

## 対象endpointとrollback

| endpoint | D1 flag | 既定値 | rollback |
|---|---|---:|---|
| `GET /api/v2/dates/{date}` | `D1_DATE_INDEX_ENABLED` | `false` | flagを`false`へ戻す |
| `GET /api/v2/competitions/{competitionId}/dates/{date}` | `D1_COMPETITION_DATE_INDEX_ENABLED` | `false` | flagを`false`へ戻す |
| `GET /api/v2/competitions/{competitionId}/seasons/{seasonId}/standings` | `D1_STANDINGS_ENABLED` | `false` | flagを`false`へ戻す |
| `GET /api/v2/fixtures/{fixtureId}` | `D1_FIXTURE_DETAIL_ENABLED` | `false` | flagを`false`へ戻す |

各endpointのflagは独立している。flag未設定または`false`では既存R2 keyとresponse pathをそのまま使い、D1 bindingを読まない。LIVE、tracking aggregatesは引き続き未移行である。

## response-ready coverage

`migrations/0002_d1_date_index_coverage.sql`は次の2表を追加する。

- `date_index_coverages`: JST date全体の完全なR2 indexをD1 fixture ID集合と照合済みであることを表す。
- `competition_date_index_coverages`: competition/date単位の完全なR2 indexを同じ粒度のD1 fixture ID集合と照合済みであることを表す。

coverage rowの不在は明示的に`not migrated`であり、空日を意味しない。`fixture_count = 0`のcoverage rowだけが「取得・検証済みの空日」を表す。これにより未投入日を誤って`200 fixtures: []`にしない。

`competition_date_index_coverages.date_jst`はgeneric coverageをFK参照する。そのためflag自体はendpoint単位で独立していても、competition coverageは同じ日付のgeneric coverage確立後に作る。competition endpointだけを先行移行する構成は採らない。

coverageはfixture件数に加え、canonical fixture IDをcode-point順に並べ、改行区切り＋末尾改行へSHA-256を取った`fixture_id_digest`を保存する。WorkerはD1から読んだfixture IDだけでdigestを再計算し、件数が同じまま集合が入れ替わる場合もfail closedにする。

fixtureの`canonical_id`、`competition_season_id`、`date_jst`の実値更新、およびfixtureの追加・削除はcoverageをtriggerで失効させる。`INSERT OR REPLACE`は暗黙DELETE triggerに依存せず、`BEFORE INSERT`で置換前日付を失効させる。`competition_seasons.competition_id`の再親付けはOLD/NEW両competitionの対象日付を失効し、competition canonical ID変更もscoped coverageを失効する。competition coverageはtriggerで明示削除し、FK cascadeも二重防御として残す。

### coverage plan

```json
{
  "schemaVersion": "d1-date-index-coverage-plan/2",
  "date": "2026-08-22",
  "dateIndex": {
    "path": "artifacts/date-index.json",
    "sourceR2Key": "football/v2/indexes/date-jst/2026-08-22.json"
  },
  "competitionIndexes": [
    {
      "competitionId": "af:competition:39",
      "path": "artifacts/competition-date-indexes/af_competition_39.json",
      "sourceR2Key": "football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json"
    }
  ]
}
```

date、competition ID、source R2 keyはartifact自身から導出せずplanで外部宣言する。artifactのrootと宣言が不一致ならcontract errorで拒否する。対象日にD1 fixtureを持つcompetitionがplanから1件でも欠ければimport全体を拒否し、reportが無警告の部分移行を成功扱いしない。

artifact pathはplan fileのdirectory相対であり、`..`とsymlinkの両方によるdirectory脱出を拒否する。genericと各competition artifactは完全なdate-index contractで検証する。D1とのfixture ID集合照合、coverage upsert、competition coverage入替は同一`BEGIN IMMEDIATE` transaction内で行い、失敗時は既存coverageを含めて状態を変えない。

```bash
node scripts/d1/import-date-index-coverage.mjs \
  --database .tmp/d1/local.sqlite \
  --plan .tmp/d1/date-index-coverage-plan.json \
  --report .tmp/d1/date-index-coverage-report.json
```

cutover用artifactはplanの`sourceR2Key`から`wrangler r2 object get ... --remote`で取得したbytesを無加工で配置する。importerはその実file bytesのSHA-256を`artifactSha256`として、明示された`sourceR2Key`と一緒にreportへ記録する。reportはfixture件数とfixture ID digestも返すが、`productionReady`は常に`false`である。

## D1 read contract

- 日付一覧はcoverageとfixtureを1 queryで読み、`idx_fixtures_date_kickoff`を使用する。
- 大会別日付一覧はcompetition identity 1 queryとcoverage/fixture 1 queryの合計2 queryで、fixture queryは`idx_fixtures_competition_date_kickoff`を使用する。
- いずれも`EXPLAIN QUERY PLAN`で`fixtures`の全表走査がないことを回帰testで固定する。
- coverage件数、実際のfixture件数、fixture IDの一意件数、fixture ID digestが一致しなければ失敗する。
- 内部rowはそのまま公開せず、既存2.0 date indexと同じDTOへ投影する。
- scoreの明示的な`0`、欠落の`null`、winnerの`true` / `false` / `null`を区別する。D1 booleanは`0` / `1`以外、数値列は非負整数／`null`以外を受理しない。
- `generatedAt`はresponse内容全体の更新時刻ではなく、fixture identity集合をR2/D1間で検証した時刻である。request時刻では上書きしない。
- fixture順は`kickoffUtc`、同時刻では`fixtureId`のcode-point順とする。
- D1成功応答は`x-jfw-data-source: d1`、TTL 300秒とする。

## 共有date-index contract

`shared/date-index-contract.mjs`をpublisher、merge、coverage importer、Worker degraded fallbackで共有する。次をfail closedで検証する。

- contract version、`Asia/Tokyo`、実在date、canonical UTC instant
- 呼出し側がgenericなら`null`、competition scopeならcanonical competition IDを必ず外部指定し、payload自身から期待scopeを導出しない
- genericではroot competitionなし、competition scopeでは完全なroot competitionあり
- fixture/competition/season/team canonical ID
- status、ingestion state、team、winner、5種類のscore pair
- fixtureのdate/competition scope
- fixture ID一意性
- `kickoffUtc`、`fixtureId`による決定的順序
- root、fixture、status、teams、score等の許可field外を拒否するclosed schema

`scripts/v2/merge-date-index.js`は宛先scopeとmerge modeをCLI引数で受け、artifact自身を期待値にしない。full-date取得とcompetition artifactは`replace`、league限定取得のgeneric artifactは`replace-scope`とし、そのleagueの旧fixtureだけを除去してからincomingを入れる。これにより延期・取消・provider誤登録の削除を手編集なしで反映できる。`upsert`は明示指定時だけ使用する。competition-scoped artifactのroot `competition`は必須である。

## Cache API

D1成功と検証済みdegraded成功だけを`caches.default`へ保存する。genericとcompetition/dateは別keyで、D1は300秒、degradedは60秒である。

- miss: `x-jfw-cache: miss`
- hit: `x-jfw-cache: hit`
- data source: `x-jfw-data-source: d1 | r2-degraded`

両headerはCORSの`Access-Control-Expose-Headers`へ追加した。origin検証とsoft rate limitはcache lookupより先に実行する。Cache APIのmatch/put失敗はresponse correctnessへ影響させない。

degraded responseがcacheされた場合、D1復旧後も最大60秒はdegradedが返る。復旧監視とshadow compareの判定窓は60秒を超えるようにする。

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
23 tests / 23 pass / 0 fail

node --test \
  tests/d1-date-index-coverage.test.js \
  tests/v2-date-index.test.js \
  tests/v2-date-feed.test.js
20 tests / 20 pass / 0 fail

node --test tests/*.test.js
290 tests / 288 pass / 0 fail / 2 todo

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
- season再親付け、`INSERT OR REPLACE`、competition ID変更による失効
- 件数保存型fixture ID入替をread時digestで拒否
- publisherのroot competition保持、明示scope、削除可能merge、同時kickoffの決定的順序
- 完全DTOだけを許すsame-entity degraded fallback
- degraded artifactの未知root/fixture field拒否
- corrupt D1数値を`null`へ丸めないfail-closed動作
- edge cache hit/missおよびcache障害からの独立
- 未知competition 404で無関係なR2を読まないこと

## production cutover前の残作業

1. Claude R2で本修正を再レビューし、PASSにする。
2. 対象環境へ`0002_d1_date_index_coverage.sql`を適用する。
3. canonical JSON/R2 bundle、Git補正定義、fixture catalog、適用済みD1、reconciled parity coverage、readiness plan v2を揃える。
4. 実R2 date/competition artifactをcoverage importerへ渡し、対象date全件のreportを保存する。
5. stagingでD1 failure injection、未移行日、明示的空日、Cache APIを実測する。
   score partsはfixtureごとに相関subqueryを使うため、query数だけでなく実際のD1 `rows_read`も記録し、必要ならJOIN/pivotへ変更する。
6. endpoint単位のsemantic shadow compareを開始し、切替後も最低7日間継続できる監視を用意する。
7. production flag変更について別途明示承認を得る。

上記が揃うまで2つのflagは`false`のままとし、production cutoverを行わない。
