# Codex self-review result — D1 Phase 3 date indexes

- review date: 2026-08-31
- branch: `feat/d1-phase3-date-indexes`
- initial code: `dcd68f2`
- reviewed fix code: `c5c5754`

## Verdict

```text
Self-review verdict: PASS
BLOCKER: 0
MAJOR: 0
MINOR: 0

Ready for independent implementation review: YES
Production date-index cutover may start: NO
```

## 初回自己レビュー findings

初回実装に次の5件を検出した。

1. competition R2 publisher mergeがroot `competition`を保持しない。
2. D1で未投入日と明示的空日を区別できない。
3. D1成功responseにedge cacheがない。
4. degraded validatorが不完全fixture DTOを受理する。
5. 同時kickoff時のR2/D1順序が一致しない。

`c5c5754`で共有contract、coverage migration/importer、coverage起点query、Cache API、publisher/merge修正を追加した。修正後の差分レビューで見つけた次の境界も同commitで閉じた。

- coverageのD1照合から登録までを同一`BEGIN IMMEDIATE`へ移し、TOCTOUを除去。
- fixture identity/scopeの後続書込みでcoverageを自動失効。
- D1数値domain逸脱を`null`へcoerceせずfail closed。
- Cache APIの同期／非同期failureをresponse pathから分離。
- plan directory脱出をlexical pathとsymlinkの双方で拒否。
- FK enforcement設定に依存せずgeneric/scoped coverageを同時に失効。
- generic coverage dateを明示`NOT NULL`にし、no-op UPSERTではcoverageを失効しない。

## 再検証

| 項目 | 結果 |
|---|---:|
| 全回帰 | 279 tests / 277 pass / 0 fail / 2 todo |
| Worker date-index | 20 / 20 pass |
| coverage・publisher | 12 / 12 pass |
| syntax check | pass |
| `git diff --check` | pass |

TODO 2件はPhase 2から継続する既知のbackfill idempotencyであり、本差分による追加ではない。

## 残るcutover blocker

実装は独立レビューへ渡せる状態だが、production cutoverは許可しない。少なくとも次が未完了である。

- Claudeによる独立レビュー
- 実R2 artifactと適用済みD1によるcoverage report
- 実データ統合readiness
- staging failure injectionとCache API実測
- 最低7日間のshadow compare監視準備
- production flag変更の別途明示承認
