# D1 Phase 2 実装レビュー結果 R4

- レビュー基準時刻: 2026-08-30 19:44 JST
- 対象: R3修正commitとパケット更新のdiff
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

## R3 findings判定

R3の3 findingと観察事項は解消済み。

- recordなしplayer用の`trackedPlayerIdentities` gateを実データで単独実行し、64 player / evidenceあり55 / evidenceなし9 / 検証済み9 / failed 0を確認した。
- event順序は`UNIQUE (fixture_revision_id, event_order)`で一意になった。
- schema index testは本番repositoryの`ORDER BY event_order`と整合した。
- expectationsの`unexpected`方向にも回帰testが追加された。

実測値:

- 全回帰: 252 tests / 250 pass / 0 fail / 2 todo / exit 0
- 既知TODO: backfill idempotency 2件
- 固定snapshot: records 120 / record由来tracked players 55 / Rating records 55 / players 64

## 新規findings

### MAJOR: D1P2-R4-001 — identity gateのaggregate期待値がimporterと同じlossy helper由来

対象: `scripts/d1/phase2-readiness.js`、`scripts/d1/fixed-snapshot-importer.js`

`trackedPlayerIdentities` gateの期待値は、fixed snapshot importerと同じ`aggregatePayload`で構築される。そのため、gateが証明するのは「importerが投影した値とD1が一致すること」だけで、snapshotのaggregate factがすべてimporterを通過したことではない。

実データではrecordなし9 playerのうち6 playerが`clubCompetitionStats`と`_aggregateBaselines`を持つが、`aggregatePayload`は両fieldを保存していない。recordがないため後から再構築できないにもかかわらず、gateは`legacySeasonAggregateVerified: true`を返す。

Phase 2で両fieldを運ぶ場合は、snapshotから独立に期待値を構築してround-tripを検証する。運ばない場合は、非移行fieldとして設計文書に列挙し、reportに`droppedFields`を出す。lossy helperの自己照合を`verified`とする現状は認めない。

### MINOR: D1P2-R4-002 — identity-only aggregateの余剰scopeを検出しない

recordなしplayerに対し、対象product seasonの`club` / `club_competition`等の余剰rowを追加してもidentity gateが通過する。recordありplayerのaggregate verifierと同様に、期待scope identityの完全一致を検証する。

### MINOR: D1P2-R4-003 — identity failure reasonの回帰testが一部ない

5種類のfailure reasonのうち3種類に専用回帰testがない。改竄injectionで実装がfail closedになることは確認できたため機能欠陥ではないが、分岐をtestで固定する。

## 再レビュー条件

Phase 2で`clubCompetitionStats`と`_aggregateBaselines`を保持するか、明示的に非移行とするかを決め、MAJOR 1件とMINOR 2件を修正する。実データcanonical bundle、Git補正定義、ローカルD1、coverage、readiness planが揃うまで、Phase 3開始とProduction cutoverを禁止する。
