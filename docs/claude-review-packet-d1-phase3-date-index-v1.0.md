# Claude review packet — D1 Phase 3 date indexes v1.0

更新日: 2026-08-31

## レビュー対象

- repository: `ssdkllpd/japanese-football-watch`
- branch: `feat/d1-phase3-date-indexes`
- base: `be581039bd0bc561353bd486ec2bc891875d77ce`
- initial implementation: `dcd68f23922cf6cc85a4ea2474a2d268f7f86863`
- self-review fix HEAD: `c5c57545c690a3d1027cf78ccbf396d8bbc2109d`
- complete code range: `be58103..c5c5754`
- fix-focused range: `e7f1fc5..c5c5754`

packet更新と自己レビュー結果はcode HEAD後のdocs-only commitに置く。実装全体を見る場合はcomplete code range、初回レビュー後の修正だけを見る場合はfix-focused rangeを使う。

## 前提

Phase 2 R5の正式判定はPASSで、Phase 3 implementation may startはYES、Production cutover may startはNO。R5のMINOR 2件とlocale順序の観察事項はPhase 2 branchの`44a94cd`で修正済みであり、本base `be58103`に含まれる。

本差分はPhase 3順序の第1項、date / competition indexesだけを実装する。feature flagは既定OFFで、deployやproduction flag変更は行っていない。

## Codex自己レビューで検出・修正した項目

| # | 初回実装の問題 | `c5c5754`の修正 |
|---|---|---|
| 1 | competition R2 mergeがroot `competition`を落とし、実publisher artifactがdegraded validationで503 | 共有contract mergeでroot保持。旧root欠落artifactの修復回帰を追加 |
| 2 | D1にcoverage証跡がなく、未投入日を明示的空日として200にできた | 2 coverage表、exact fixture ID照合importer、明示的空日の0件row、identity write失効triggerを追加 |
| 3 | D1成功pathがCache APIを使わず、閲覧ごとにD1 read | generic/competition別edge response cacheとhit/miss観測を追加 |
| 4 | degraded validatorがfixture DTOの主要field欠落を許した | publisher/importer/Worker共通の完全date-index validatorへ置換 |
| 5 | 同時kickoff時にR2とD1の順序が一致しなかった | publisher、merge、contract、D1 queryを`kickoffUtc + fixtureId`へ統一 |

追加の差分レビューで、coverage照合と登録のTOCTOU、後続fixture identity writeによるcoverage陳腐化、D1不正数値の`null`化、Cache API障害のresponse波及も閉じた。FK設定に依存しないscoped coverage削除、coverage dateの`NOT NULL`、実値変更時だけ発火するtrigger条件も`c5c5754`に含まれる。

## 変更file

| file | 内容 |
|---|---|
| `migrations/0002_d1_date_index_coverage.sql` | generic/competition coverage表、fixture identity/scope write時の失効trigger |
| `scripts/d1/import-date-index-coverage.mjs` | artifact完全検証、exact ID集合照合、atomic coverage import/report |
| `shared/date-index-contract.mjs` | 完全date-index validator、決定的sort、root保持merge |
| `scripts/v2/fetch-date-feed.js` | publisherの決定的sortとpublish前validation |
| `scripts/v2/merge-date-index.js` | strict JSON readと共有contract merge |
| `worker/index.mjs` | coverage起点D1 query、DTO validator、未移行fallback、degraded fallback、Cache API |
| `.github/workflows/test.yml` | 新規ESM runtime scriptのsyntax check |
| `tests/d1-date-index-coverage.test.js` | coverage import、空日、rollback、path、失効trigger |
| `tests/v2-date-index.test.js` | merge/upsert、同時kickoff、legacy root修復 |
| `tests/v2-date-feed.test.js` | publisherの決定的順序 |
| `tests/v2-worker.test.js` | query plan、coverage、DTO、fallback、cache、failure injection |

## 重点レビュー項目

1. flag未設定／OFF時に既存R2経路が変わらず、D1 readが0回であること。
2. coverage row不在と`fixture_count = 0`がそれぞれ未移行／検証済み空日として区別されること。
3. coverage importerがgeneric/competition artifactの完全contractとD1 exact fixture ID集合を同一transaction内で照合すること。
4. fixture identity/scope write後にcoverageが失効し、古い0件／件数証跡が残らないこと。
5. 日付一覧が1 query、大会別日付一覧が2 query以内で、各専用indexを使い`fixtures`全表走査をしないこと。
6. D1 rowを公開せず既存date index DTOへ投影し、明示的な`0`、`false`、`null`を保持すること。
7. D1のboolean／数値domain逸脱をcoerceせずdegradedへ閉じること。
8. 2 endpointのflag、coverage、Cache API keyが独立し、片方の切替が他方へ波及しないこと。
9. publisherとD1の双方が`kickoffUtc`、`fixtureId`で同じ順序になること。
10. R2 competition publisher artifactがroot competitionを保持し、旧欠落artifactも次回mergeで修復できること。
11. D1 error時にretryせず、同一dateまたは同一competition/dateのR2 keyだけへfallbackすること。
12. fallback payloadのrootだけでなく全fixture DTO、ID一意性、順序までruntimeで検証すること。
13. Cache API障害がD1成功responseをdegraded/5xxへ変えず、origin/rate limitがcacheより先に評価されること。
14. `x-jfw-data-source`、`x-jfw-cache`、`degraded`、`lastSuccessfulAt`により経路を判別できること。
15. standings、fixture detail、LIVE、tracking read pathおよびproduction cutover条件を開いていないこと。

## 実測値

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

git diff --check be58103..c5c5754
pass
```

TODO 2件は既知のbackfill idempotency。

## 要求する判定

```text
Verdict: PASS | CHANGES_REQUIRED
BLOCKER: n
MAJOR: n
MINOR: n

Phase 3 date-index implementation accepted: YES | NO
Production date-index cutover may start: NO
```

このレビューで許可対象にできるのは実装の受入れまでである。実データ統合readiness、coverage report、staging failure injection、最低7日間のshadow運用準備、別途の明示承認が揃うまではproduction flagを変更しない。
