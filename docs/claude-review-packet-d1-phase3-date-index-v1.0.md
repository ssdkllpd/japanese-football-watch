# Claude review packet — D1 Phase 3 date indexes R2

更新日: 2026-08-31

## レビュー対象

- repository: `ssdkllpd/japanese-football-watch`
- branch: `feat/d1-phase3-date-indexes`
- base: `be581039bd0bc561353bd486ec2bc891875d77ce`
- initial implementation: `dcd68f23922cf6cc85a4ea2474a2d268f7f86863`
- R1 reviewed code: `c5c57545c690a3d1027cf78ccbf396d8bbc2109d`
- R1 fix code HEAD: `a173d4450def8f92eb1a0200c083a52a7c22de5d`
- complete code range: `be58103..a173d44`
- R2 fix-focused range: `c5c5754..a173d44`

packet更新、R1結果、Codex R2自己レビューはcode HEAD後のdocs-only commitに置く。実装全体を見る場合はcomplete code range、R1指摘への修正だけを見る場合はR2 fix-focused rangeを使う。

## 前提

Phase 2 R5の正式判定はPASSで、Phase 3 implementation may startはYES、Production cutover may startはNO。R5のMINOR 2件とlocale順序の観察事項はPhase 2 branchの`44a94cd`で修正済みであり、本base `be58103`に含まれる。

本差分はPhase 3順序の第1項、date / competition indexesだけを実装する。feature flagは既定OFFで、deployやproduction flag変更は行っていない。

## R1 verdict

`docs/claude-review-result-d1-phase3-date-index-2026-08-31-r1.md`に記録したR1判定は次のとおり。

```text
Verdict: CHANGES_REQUIRED
BLOCKER: 0
MAJOR: 2
MINOR: 5
```

## R1 findingsへの対応

| finding | 対応 |
|---|---|
| D1P3-R1-001 MAJOR | `competition_seasons.competition_id`とcompetition canonical ID変更の失効triggerを追加。coverageへfixture ID digestを保存し、WorkerがD1 read IDsだけからSHA-256を再計算して件数保存型入替も拒否 |
| D1P3-R1-002 MAJOR | `expectedCompetitionId`のself-derivationを廃止。validator、merge CLI、coverage plan v2、Workerの全経路でgeneric `null`またはcanonical competition IDを外部指定 |
| D1P3-R1-003 MINOR | fixture conflictを検出する`BEFORE INSERT` triggerを追加し、`INSERT OR REPLACE`の暗黙DELETEに依存せず旧日付を失効 |
| D1P3-R1-004 MINOR | merge modeを明示化。full date/competitionは`replace`、league限定genericは`replace-scope`で対象competitionの旧集合を除去。CLIから修復可能 |
| D1P3-R1-005 MINOR | coverage dateをSQLite date正規化一致、instantをmilliseconds付きcanonical UTC形式、SHAをlowercase hex 64桁でDB CHECK |
| D1P3-R1-006 MINOR | plan v2でdate、competition ID、source R2 keyを宣言。対象日にfixtureを持つD1 competitionの未宣言をtransaction内で拒否。reportはkey、artifact bytes hash、ID digestを記録 |
| D1P3-R1-007 MINOR | root、fixture、competition、status、teams、team、score、score pairの許可key集合をcontractへ追加。degraded未知fieldを503へ閉じる |

R1 observationのうち、R2 artifact取得失敗を`|| true`で隠すworkflowも修正した。明示的なnot-foundだけを初回publishとして扱い、その他のR2 get失敗ではput前にworkflowを停止する。`generatedAt`の意味、degraded cache TTL、competition coverageのgeneric coverage依存、staging `rows_read`実測条件は実装文書へ明記した。

## 初回Codex自己レビューで検出・修正した項目

| # | 初回実装の問題 | `c5c5754`の修正 |
|---|---|---|
| 1 | competition R2 mergeがroot `competition`を落とし、実publisher artifactがdegraded validationで503 | 共有contract mergeでroot保持。旧root欠落artifactの修復回帰を追加 |
| 2 | D1にcoverage証跡がなく、未投入日を明示的空日として200にできた | 2 coverage表、exact fixture ID照合importer、明示的空日の0件row、identity write失効triggerを追加 |
| 3 | D1成功pathがCache APIを使わず、閲覧ごとにD1 read | generic/competition別edge response cacheとhit/miss観測を追加 |
| 4 | degraded validatorがfixture DTOの主要field欠落を許した | publisher/importer/Worker共通の完全date-index validatorへ置換 |
| 5 | 同時kickoff時にR2とD1の順序が一致しなかった | publisher、merge、contract、D1 queryを`kickoffUtc + fixtureId`へ統一 |

追加の差分レビューで、coverage照合と登録のTOCTOU、後続fixture identity writeによるcoverage陳腐化、D1不正数値の`null`化、Cache API障害のresponse波及も閉じた。これらはR1対象`c5c5754`までに含まれる。

## 変更file

| file | 内容 |
|---|---|
| `migrations/0002_d1_date_index_coverage.sql` | coverage表、ID digest、strict DB CHECK、fixture/season/competition失効trigger |
| `scripts/d1/import-date-index-coverage.mjs` | plan v2外部scope、artifact検証、competition完全性、exact ID集合、digest、atomic report |
| `shared/date-index-contract.mjs` | closed-schema validator、明示scope、決定的sort、replace/replace-scope/upsert merge |
| `scripts/v2/fetch-date-feed.js` | publisherの決定的sortとpublish前validation |
| `scripts/v2/merge-date-index.js` | strict JSON readと共有contract merge |
| `.github/workflows/v2-date-feed.yml` | 明示scope/mode merge、R2 get一時failure時のpublish停止 |
| `worker/index.mjs` | coverage起点D1 query、DTO validator、未移行fallback、degraded fallback、Cache API |
| `.github/workflows/test.yml` | 新規ESM runtime scriptのsyntax check |
| `tests/d1-date-index-coverage.test.js` | coverage import、空日、rollback、path、失効trigger |
| `tests/v2-date-index.test.js` | 明示scope、upsert/replace/replace-scope、削除反映 |
| `tests/v2-date-feed.test.js` | publisherの決定的順序とmanifest merge宣言 |
| `tests/v2-worker.test.js` | query plan、coverage、DTO、fallback、cache、failure injection |

## 重点レビュー項目

1. flag未設定／OFF時に既存R2経路が変わらず、D1 readが0回であること。
2. coverage row不在と`fixture_count = 0`がそれぞれ未移行／検証済み空日として区別されること。
3. coverage plan v2のdate/competition ID/source keyがartifactと独立し、未宣言competitionを拒否すること。
4. fixture ID digestがimporterとWorkerで独立計算され、同数ID入替をread時に拒否すること。
5. fixture、season再親付け、competition ID変更、`INSERT OR REPLACE`後にcoverageが失効すること。
6. full/competition `replace`とgeneric `replace-scope`が上流削除を反映し、別scopeを削除しないこと。
7. 日付一覧が1 query、大会別日付一覧が2 query以内で、各専用indexを使い`fixtures`全表走査をしないこと。
8. D1 rowを公開せず既存date index DTOへ投影し、明示的な`0`、`false`、`null`を保持すること。
9. D1のboolean／数値domain逸脱をcoerceせずdegradedへ閉じること。
10. publisherとD1の双方が`kickoffUtc`、`fixtureId`で同じ順序になること。
11. D1 error時にretryせず、同一entityのR2 keyだけへfallbackすること。
12. degraded payloadが未知field、別scope、不完全DTO、重複ID、順序違反を拒否すること。
13. Cache API障害がD1成功responseをdegraded/5xxへ変えず、flag/origin/rate limitがcacheより先に評価されること。
14. R2 getの一時failureが既存artifactを空currentとして上書きしないこと。
15. standings、fixture detail、LIVE、tracking read pathおよびproduction cutover条件を開いていないこと。

## 実測値

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

git diff --check c5c5754..a173d44
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
