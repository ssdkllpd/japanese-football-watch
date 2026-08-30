# D1 Phase 2 implementation — Claude formal review packet v1.0

状態: **CHANGES APPLIED — CLAUDE RE-REVIEW REQUIRED — PHASE 3 CUTOVER BLOCKED**

対象branch: `design/d1-r2-er-screen-flow`

初回レビュー対象HEAD: `3f9fe90ffa5ccad8c21b478180619114c7702c61`

修正対象HEAD: `613ed23131bb1b2733c555bd9d0d5428a1d21914`

初回レビュー結果: `docs/claude-review-result-d1-phase2-2026-08-30.md`

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
| `613ed23` | Claude findings: expected scope、order parity、correction provenance、constraints |

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
| `fixtureRecords` | plan v2の`fixtureRecordIds`全件が公開D1 appearanceへ一意にlinkされ、比較可能な全fact parityがpassed |
| `fixtureShadows` | scoped fixtureのJSON/R2、公開D1、独立Git補正定義が一致し、event/lineup entry順も一致 |
| `trackedPlayerCrosswalks` | `trackedPlayerIds`全員と全membership期間がprovider evidenceどおりのCore identityへresolved |
| `jfwRatings` | `ratingRecordIds`全件がauthored値・null状態・source hash・公開revisionと一致 |
| `trackedPlayerAggregates` | `aggregatePlayerIds`全員の期待scopeが値・null・欠落・source hash・scope identityまで一致 |

5 gateの論理積だけが`phase2TechnicalGatePassed`になる。技術gate通過後も、Claude正式レビューまでは次を維持する。

```json
{
  "productionReady": false,
  "phase3CutoverReady": false,
  "remainingGates": ["claude_formal_review"]
}
```

## 4. 初回レビューと修正結果

初回Codex自己レビューのBLOCKER 0 / MAJOR 0判定は撤回する。Claude実データレビュー結果は次のとおり。

Verdict: **CHANGES_REQUIRED**

BLOCKER: 2

MAJOR: 3

MINOR: 4

全findingを`613ed23`で反映済み。主な修正:

- plan v2でfixture record、crosswalk player、Rating record、aggregate playerの期待分母を必須宣言する。
- scope外は`not_applicable`、scope内の証拠不足は`deferred`として分離する。
- eventとlineup entryの配列順をparity対象に戻し、D1へ`entry_order`を保存する。
- 補正はGit定義、JSON/R2、D1の三者照合とし、比較JSONからの定義注入を廃止する。
- link+parityはreadiness実行中に1回だけ再計算し、各verifierで共有する。
- tracking statusへDB CHECKを追加する。

## 5. 検証証跡

- Claude finding関連tests: **59 pass / 0 fail**
- `node --test tests/*.test.js`: **246 tests / 244 pass / 0 fail / 2 todo / exit 0**
- 既知TODO: backfill idempotency 2件
- `git diff --check`: pass

## 6. 未充足の切替証跡

実データsnapshotの分母不成立は`613ed23`で修正した。ただしリポジトリには、期待scope全件の完全な2.1 canonical JSON/R2 bundle、Git補正定義、fixture catalog、適用済みローカルD1 database、reconciled parity coverage、readiness plan v2が保存されていない。そのため、現時点で実データ期待scopeの`phase2TechnicalGatePassed: true`は確認していない。

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

`3f9fe90..613ed23`を対象に、初回findingが解消されたかdiff-focusedで再レビューし、次の形式で回答すること。

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
