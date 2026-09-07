# D1 Phase 3 date index 実装レビュー結果 R1

- レビュー基準時刻: 2026-08-31 13:31 JST
- 対象branch: `feat/d1-phase3-date-indexes`
- packet HEAD: `791b4260b6657c9183e9df9c9bde3cecec699803`
- code HEAD: `c5c57545c690a3d1027cf78ccbf396d8bbc2109d`
- complete code range: `be58103..c5c5754`
- 方式: fresh clone、実コード読解、in-memory `node:sqlite`への`0001`/`0002`適用、failure injection

## Verdict

```text
Verdict: CHANGES_REQUIRED
BLOCKER: 0
MAJOR: 2
MINOR: 5

Phase 3 implementation review passed: NO
Production cutover may start: NO
```

feature flagは既定OFFで、production flag変更workflowとdeploy pathは存在しない。判定は実装受入れの保留であり、production露出済み欠陥ではない。

## 実測

```text
node --test tests/*.test.js
279 tests / 277 pass / 0 fail / 2 todo

node --test tests/v2-worker.test.js
20 tests / 20 pass / 0 fail

node --test tests/d1-date-index-coverage.test.js tests/v2-date-index.test.js tests/v2-date-feed.test.js
12 tests / 12 pass / 0 fail

node --check worker/index.mjs                           pass
node --check scripts/d1/import-date-index-coverage.mjs pass
node --check shared/date-index-contract.mjs            pass
git diff --check be58103..c5c5754                      pass
```

TODO 2件はPhase 2から継続するbackfill idempotencyであり、本差分起因ではない。

## Findings

### MAJOR: D1P3-R1-001 — season再親付けでcoverageが失効せず、別大会fixtureをD1権威応答として返せる

対象:

- `migrations/0002_d1_date_index_coverage.sql:27-52`
- `worker/index.mjs:77-95,330-347`

`competition_seasons.competition_id`をcompetition 39と140の間で件数を保ったまま入れ替えると、fixture表triggerは発火せず、両coverageが残った。Workerのread gateは件数とID一意性だけだったため、39 routeが140のfixture IDsを`200 / x-jfw-data-source: d1`で返すことを実測した。

要求:

- season parent変更時にOLD/NEW competition coverageを失効する。
- coverageへfixture ID digestを保存し、WorkerがD1 read IDsだけから再計算して照合する。
- 件数保存型scope入替の回帰testを追加する。

### MAJOR: D1P3-R1-002 — date-index scopeの期待値を検証対象自身から導出している

対象:

- `shared/date-index-contract.mjs:151-154,198-201`
- `scripts/d1/import-date-index-coverage.mjs:100-104`

`expectedCompetitionId`未指定時にpayload rootから値を取り、mergeとcoverage importerもartifact自身を期待値としていた。root欠落competition artifact、別competition artifactの取り違え、genericとして解釈された混成artifactを共有contract単独では拒否できなかった。

要求:

- validatorのscope明示を必須にする。
- merge宛先scopeをCLI引数で受ける。
- coverage planでdateとcompetition IDを外部宣言し、artifactとの不一致をcontract errorとして拒否する。

### MINOR: D1P3-R1-003 — `INSERT OR REPLACE`の日付移動で旧日付coverageが残る

SQLiteの`recursive_triggers`既定OFFではREPLACEの暗黙DELETEがDELETE triggerを発火しない。旧日付coverageが残って503/degradedへ固定されるため、REPLACE禁止の明記または置換前日付を確実に失効する仕組みが必要。

### MINOR: D1P3-R1-004 — upsert-only mergeに上流削除の復旧手段がない

current fixtureがincomingから消えてもmerge後に残る。D1側から削除済みの場合、coverage importerはR2余剰を永続的に拒否する。authoritative replacement、tombstone、または修復commandが必要。

### MINOR: D1P3-R1-005 — coverage DB CHECKが不正date/instantを受理する

`abcd-ef-gh`、`9999-99-99`、`2026-02-30`、millisecondsなし／不正UTC instantをcoverage表へ格納できた。runtime contractは拒否するため誤配信にはならないが、DB制約とcontractが不一致。

### MINOR: D1P3-R1-006 — coverage planが期待scopeと完全なcompetition集合を宣言しない

fixtureを持つcompetitionの未宣言、competition artifact取り違え、artifact自身からの日付導出が無警告で成立した。planへdate、competition ID、source R2 keyを宣言し、D1上の対象competitionとの差分を失敗またはreportする必要がある。

### MINOR: D1P3-R1-007 — degraded R2 pathが未知fieldを応答へ素通しする

top-level未知field、fixtureの`referee`や`providerRaw`が`200 r2-degraded`へ残ることを実測した。closed projectionまたはstrict key validationが必要。

## Observation

- coverageの`generatedAt`は内容全体の更新時刻ではなくidentity集合検証時刻であるため、契約上の意味を明記する。
- score partsはfixture 1件あたり8本の相関subquery。stagingで`rows_read`を実測する。
- degraded応答は60秒cacheされるため、復旧監視窓はTTLを跨ぐ必要がある。
- competition coverageはgeneric coverageをFK参照し、competition endpoint単独先行移行はできない。
- R2 get失敗を`|| true`で処理すると既存artifactを落としうる。
- branch名は単数形ではなく`feat/d1-phase3-date-indexes`。

## Production cutoverを許可しない残条件

1. MAJOR 2件を解消し、R2レビューでPASSにする。
2. MINOR 5件を解消または明示受容する。
3. 対象環境へmigrationを適用する。
4. canonical JSON/R2 bundle、Git補正定義、fixture catalog、適用済みD1、parity coverage、readiness plan v2を整合させる。
5. 実R2 object bytesによるcoverage reportを全対象日分保存する。
6. staging failure injection、Cache API、`rows_read`を実測する。
7. endpoint単位shadow compareを開始し、切替後最低7日継続できるようにする。
8. production flag変更の明示承認を得る。

レビュー中、コード修正、commit、merge、flag変更、deployは行われていない。
