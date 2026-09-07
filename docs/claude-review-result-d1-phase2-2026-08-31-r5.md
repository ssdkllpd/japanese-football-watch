# D1 Phase 2 実装レビュー結果 R5

- レビュー基準時刻: 2026-08-31 09:30 JST
- 対象: R4修正commit `ad2758d`（code差分 `a8b4bc1..ad2758d`）
- packet HEAD: `d9ebb5f`
- branch: `fix/d1-phase2-review-r2`

## Verdict

```text
Verdict: PASS
BLOCKER: 0
MAJOR: 0
MINOR: 2

Phase 3 implementation may start: YES
Production cutover may start: NO
```

## 実測環境

- Node v22.22.2 / `node:sqlite` `DatabaseSync(':memory:')`
- fixed snapshot artifact: `bfda9fa6e3bfdc5abaf1e37ffe1dc9962b7a557756be08bc3d1c366c4ba1fe49`
- season `2026-27` / players 64 / records 120 / record由来player 55 / recordなしplayer 9
- 全回帰: 256 tests / 254 pass / 0 fail / 2 todo / exit 0
- `git diff --check a8b4bc1..ad2758d`: clean

## R4 findings判定

R4の3 findingはすべて解消済み。

- `clubCompetitionStats`と`_aggregateBaselines`はrecordなしplayer 9/9、全player 64/64で完全一致した。
- readiness期待値は`expectedLegacyAggregatePayload`としてimporterから独立した。importer側だけを退行させた場合、identity gateが9/9 failedで閉じることを確認した。
- 対象product seasonの余剰scopeは`legacy_aggregate_scope_set_mismatch`で拒否された。
- identity failure reason 6分岐にそれぞれ専用回帰testが存在する。
- 6 gateの論理積、`productionReady: false`、`phase3CutoverReady: false`、`claude_formal_review`の残存は維持された。

## 新規findings

### MINOR: D1P2-R5-001 — 移行対象外fieldが宣言も報告もされない

recordなし9 playerの`statsScope`、`statsStatus`、`statsAsOf`、`_initialStats`、`_initialClub`、`_initialLeague`、`_initialStatsUpdated`がD1に保存されていない。baselineもrecordもない3 playerはD1単体で検証状態を復元できない。`stats_json`へ追加してsnapshot由来期待値と照合するか、非移行fieldとして明示しreportに`droppedFields`を出す。

### MINOR: D1P2-R5-002 — scope集合検証が対象product seasonに閉じている

同一`jfw_player_id`に別product seasonのaggregate行を追加してもidentity gateが通過する。Phase 2で許可するproduct season集合を完全一致で検証する。

## 観察事項

`phase2-readiness.js`のlocale未指定`localeCompare()`はICU環境依存で、report配列順と`players[0]`を参照するtestが順序依存になる。比較方法を固定し、testはplayer IDで対象を取得することを推奨する。

## 判定理由

R4の構造的欠陥は解消した。したがって、feature flag既定OFF、endpoint単位rollback、D1 read失敗時のR2 degraded fallbackを含むPhase 3実装の着手を許可する。

Production cutoverは許可しない。実データの完全なcanonical bundle / Git補正定義 / fixture catalog / local D1 / reconciled coverage / readiness plan v2が揃わず、統合`phase2TechnicalGatePassed: true`が未確認であることと、MINOR 2件がcutover前に未解消であることが理由である。
