# D1 Phase 2 実装レビュー結果 R3

- レビュー基準時刻: 2026-08-30 16:13 JST
- 対象: `4b3809f..087479e`
- コード修正commit: `afd2767`
- packet更新commit: `087479e`
- branch: `fix/d1-phase2-review-r2`

## Verdict

```text
Verdict: CHANGES_REQUIRED
BLOCKER: 0
MAJOR: 1
MINOR: 2

Phase 3 implementation may start: NO
Production cutover may start: NO
```

## R2 findings判定

R2の8 findingはすべて解消済み。

- expectationsの過少・過大宣言はsnapshot由来4集合との完全一致validationで拒否される。
- eventsは`event_order`単独でsource配列順をround-tripする。
- Rating件数はproduct seasonと`player_record_id:rating_version`の複合条件で照合される。
- lineup `entry_order`のDEFAULTは削除され、省略時にNOT NULL違反となる。
- ordered array判定はcontract pathに限定された。
- Git補正定義はcanonical import開始前にbundleと照合される。
- `git diff --check`は対象rangeでpassした。

実測値:

- 全回帰: 250 tests / 248 pass / 0 fail / 2 todo / exit 0
- 既知TODO: backfill idempotency 2件
- 固定snapshot: records 120 / record由来tracked players 55 / Rating records 55 / players 64

## 新規findings

### MAJOR: D1P2-R3-001 — recordなしplayerのidentityとmembershipがreadiness対象外

対象: `scripts/d1/phase2-readiness.js:95`、`scripts/d1/fixed-snapshot-importer.js:134`

fixed snapshot importerはsnapshot全64 playerの`tracked_players`とmembershipをD1へ保存するが、resolved crosswalk gateはrecord由来55 playerだけを検証し、残る9 playerを`outside_phase2_expected_scope`として扱う。完全一致validationによりplanから9 playerを追加することもできず、書込み対象と検証対象の乖離が恒久化する。

recordなしplayerはmatch由来provider evidenceがないためresolved crosswalkの分母へ混ぜない。その代わり、以下を検証する独立gateを追加する。

- `tracked_players.crosswalk_state`が`resolved`ではないこと
- tracking属性がsnapshotと一致すること
- legacy membershipのラベル、期間、tracking status、change type、verification、source hashがsnapshotと一致すること
- reportでは`not_applicable`ではなく`no_match_evidence`として明示すること

### MINOR: D1P2-R3-002 — event_order単独sortをDB一意性が保証していない

対象: `migrations/0001_d1_core.sql:451`

`ux_fixture_events_order`を`UNIQUE (fixture_revision_id, event_order)`へ変更し、repositoryのsort keyをDB制約で一意にする。

### MINOR: D1P2-R3-003 — schema index testが旧timeline queryを検証している

対象: `tests/d1-schema.test.js:277`

利用されなくなった`ORDER BY elapsed, extra_minute, event_order`と`idx_fixture_events_timeline`の検証を削除し、公開repositoryと同じ`ORDER BY event_order`および`ux_fixture_events_order`を検証する。

## 観察事項

完全一致validationの`unexpected`側に専用testがない。実装は正しく拒否するためfindingではないが、回帰testを追加することが望ましい。

## 再レビュー条件

上記3 findingと観察事項のtest補強後、R3修正commitをdiff-focusedで再レビューする。実データcanonical bundle、Git補正定義、ローカルD1、coverage、readiness planが揃うまでは、Phase 3開始とProduction cutoverを禁止する。
