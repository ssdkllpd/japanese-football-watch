# D1 Phase 2 implementation — Claude formal review packet v1.0

状態: **READY FOR CLAUDE FORMAL REVIEW — PHASE 3 CUTOVER BLOCKED**

対象branch: `design/d1-r2-er-screen-flow`

対象HEAD: `3f9fe90ffa5ccad8c21b478180619114c7702c61`

実装範囲: `13db235..3f9fe90`

## 1. レビュー目的

D1 Phase 1/2実装が、承認済みのD1/R2設計とfail-closed migration規則を満たしているかを独立に確認する。今回のレビューはPhase 3 endpoint切替の前提条件であり、runtime正本の切替そのものは対象外とする。

レビュー対象は次の3点である。

1. 固定snapshotからD1へ移すCore facts、tracking、Rating、aggregateで、ID・revision・期間・`0`・`null`・欠落が保持されること。
2. JSON/R2正本と公開D1 revisionのsemantic shadow、record linkage、fact parityが保存済みreportを信用せず再検証されること。
3. 5つの技術gateがすべて通るまで、`productionReady`と`phase3CutoverReady`が常に`false`のままであること。

## 2. 対象commit

| Commit | 内容 |
|---|---|
| `13db235` | reviewed D1 Core schema |
| `eb05c9a` | fixture DTO parity correction |
| `0b773f8` | D1 fixture shadow repository |
| `7b00c93` | fixed snapshot importer |
| `269cce7` | fixture coverage manifest |
| `abec759` | semantic fixture shadow compare |
| `8cd1bd7` | batch shadow reports |
| `6c3b185` | canonical fixture bundle importer |
| `805d3b2` | batch canonical fixture import |
| `240b9aa` | legacy record to canonical fixture linkage |
| `de50444` | canonical fixture fact parity |
| `e25caa8` | exact tracked-player crosswalk preflight |
| `a93a8e8` | verified crosswalk application |
| `6917c73` | authored JFW Rating migration |
| `62e9507` | verified tracked-player aggregate rebuild |
| `3f9fe90` | integrated read-only Phase 2 readiness verification |

主な実装・仕様ファイル:

- `migrations/0001_d1_core.sql`
- `scripts/d1/`
- `tests/d1-*.test.js`
- `docs/data-storage-d1-r2-design-v1.0.md`
- `docs/d1-local-import-runbook-v1.0.md`

## 3. 統合readiness gate

`scripts/d1/verify-phase2-readiness.js`は次の5 gateをread-onlyで再計算する。

| Gate | 合格条件 |
|---|---|
| `fixtureRecords` | 固定snapshotの全legacy recordが公開D1 appearanceへ一意にlinkされ、比較可能な全fact parityがpassed |
| `fixtureShadows` | plan内の全JSON/R2 canonical bundleが、実行時にD1から再構築した公開bundleとsemantic一致 |
| `trackedPlayerCrosswalks` | 全追跡playerと全membership期間がprovider evidenceどおりのCore player/team/competition seasonへresolved |
| `jfwRatings` | 対象product seasonの全期待Ratingがauthored値・null状態・source hash・公開revisionと一致 |
| `trackedPlayerAggregates` | 対象product seasonの全期待scopeが値・null・欠落・source hash・scope identityまで一致 |

5 gateの論理積だけが`phase2TechnicalGatePassed`になる。技術gate通過後も、Claude正式レビューまでは次を維持する。

```json
{
  "productionReady": false,
  "phase3CutoverReady": false,
  "remainingGates": ["claude_formal_review"]
}
```

## 4. Codex自己レビュー結果

Verdict: **PASS FOR FORMAL REVIEW / NOT APPROVED FOR CUTOVER**

BLOCKER: 0

MAJOR: 0

MINOR: 0

確認済み事項:

- readiness CLIはSQLiteを`readOnly: true`で開き、検証中の修復・上書きを行わない。
- fixture linkageとfact parityはcoverage内の古い結果を採用せず、固定snapshotと公開D1 revisionから再計算する。
- shadow compareは保存済みD1 artifactを採用せず、実行時のD1 repository結果をJSON/R2正本と比較する。
- crosswalkはplayer IDだけでなく、全期間のteam、competition season、tracking status、change type、verification、methodを照合する。
- Ratingとaggregateは固定snapshotのproduct seasonにscopeを限定し、過去seasonの行数を混入させない。
- authored `jfwRating: null`、明示的`0`、property欠落を別状態として維持する。
- 既存行のsource hashまたはpayloadが競合する場合はfail closedとし、自動修復しない。
- reportの`productionReady`と`phase3CutoverReady`は技術gateの結果にかかわらず`false`で固定される。

## 5. 検証証跡

- Phase 2 readiness focused tests: **6 pass / 0 fail**
- crosswalkを含む関連tests: **30 pass / 0 fail**
- `node --test --test-reporter=dot tests/*.test.js`: **exit 0**
- 既知TODO: `reapplying the same backfill currently exposes membership replay drift` 1件
- `git diff --check`: pass
- branch HEADとremote HEAD: `3f9fe90ffa5ccad8c21b478180619114c7702c61`で一致

## 6. 未充足の切替証跡

リポジトリには、全対象fixtureの完全な2.1 canonical JSON/R2 bundle、fixture catalog、適用済みローカルD1 database、reconciled parity coverage、readiness planが保存されていない。そのため、現時点で実データ全件の`phase2TechnicalGatePassed: true`は確認していない。

これはコードレビューを妨げないが、Phase 3 cutoverの承認条件を満たさない。実データ成果物が揃った後に、次を実行し、reportをこのパケットへ添付する必要がある。

```bash
node scripts/d1/verify-phase2-readiness.js \
  --snapshot /path/to/fixed-snapshot.json \
  --coverage /path/to/fixture-coverage-parity.json \
  --database /path/to/local-d1.sqlite3 \
  --plan /path/to/readiness/plan.json \
  --report /path/to/d1-phase2-readiness-report.json
```

## 7. Claudeへの判定依頼

次の形式で回答すること。

```text
Verdict: PASS | CHANGES_REQUIRED
BLOCKER: <count>
MAJOR: <count>
MINOR: <count>

Findings:
- [severity] file:line — finding

Phase 3 implementation may start: YES | NO
Production cutover may start: NO
```

`Phase 3 implementation may start: YES`は、feature flag既定OFF・endpoint単位rollback・D1 read failure時の検証済みR2 degraded fallbackを含む実装着手だけを許可する。実データ統合reportと切替前failure injectionが未通過のため、今回のレビュー結果だけでproduction cutoverを許可してはならない。

