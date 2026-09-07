# Codex self-review result — D1 Phase 3 date indexes R2

- review date: 2026-08-31
- branch: `feat/d1-phase3-date-indexes`
- Claude R1 reviewed code: `c5c5754`
- R1 fix code: `a173d4450def8f92eb1a0200c083a52a7c22de5d`
- fix-focused range: `c5c5754..a173d44`

## Verdict

```text
Self-review verdict: PASS
BLOCKER: 0
MAJOR: 0
MINOR: 0

Ready for Claude R2 review: YES
Production date-index cutover may start: NO
```

## R1 findings再検証

| finding | 判定 | 独立した確認 |
|---|---|---|
| D1P3-R1-001 | 解消 | season parent変更でOLD/NEW scoped coverageが0件になる。失効triggerを外してfixture IDを同数差替えしても、Workerが手書きdigestとの差で503へ閉じる |
| D1P3-R1-002 | 解消 | validator/mergeはscope未指定を拒否。root欠落、39 artifactを140宣言、plan source key/date不一致を専用testで拒否 |
| D1P3-R1-003 | 解消 | `recursive_triggers=0`のまま`INSERT OR REPLACE`で日付移動し、旧日付coverageが0件になることを確認 |
| D1P3-R1-004 | 解消 | authoritative `replace`が旧fixtureを除去。generic `replace-scope`が宣言competitionだけを除去し、他competitionを保持 |
| D1P3-R1-005 | 解消 | 不正文字date、存在しない日付、millisecondsなし／不正UTC instantをDB CHECKで拒否 |
| D1P3-R1-006 | 解消 | plan v2のcompetition省略、artifact取り違え、source key取り違えを拒否。成功reportはundeclared competitions空、key、bytes hash、ID digestを記録 |
| D1P3-R1-007 | 解消 | degraded artifactへ未知root fieldとfixture `referee`を同時注入し、503・`unavailable`を確認 |

## 構造確認

### fixture ID digest

importerはD1のexact ID集合とartifact ID集合を双方向照合した後、D1 IDsからdigestを保存する。Workerはqueryで返ったD1 fixture DTOからIDだけを抽出してWeb Cryptoで再計算する。test seedはproduction helperを使わず、Node `crypto`と手書きのsort/joinで期待digestを作るため、Workerの自己照合testではない。

canonical digest input:

```text
code-point sortしたfixture ID
改行区切り
末尾改行あり
SHA-256 lowercase hex
```

空集合は改行1文字のSHA-256である。

### 外部scope

- generic: `expectedCompetitionId: null`
- competition: plan/CLI/routeがcanonical competition IDを指定
- coverage date: plan `date`を指定
- source object: plan `sourceR2Key`を指定し、canonical keyと完全一致を要求

payloadのroot competition、date、file名から期待scopeを導出しない。

### 削除可能merge

- full generic date: `replace`
- competition date: `replace`
- `--league`付きgeneric date: `replace-scope`
- legacy `upsert`: 明示指定時のみ

publisher manifestがscope/mode/replacement competitionを宣言し、workflowはその宣言をCLIへ渡す。R2 getのnot-found以外のfailureではputへ進まない。

### coverage invalidation

- fixture INSERT / DELETE / identity-scope UPDATE
- fixture `INSERT OR REPLACE`の置換前conflict
- competition season INSERT / DELETE / parent competition UPDATE
- competition canonical ID UPDATE

trigger漏れがあっても、fixture ID digestのread-time照合がidentity集合の最終防御になる。

## 回帰結果

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

node --check worker/index.mjs                           pass
node --check scripts/d1/import-date-index-coverage.mjs pass
node --check shared/date-index-contract.mjs            pass
node --check scripts/v2/merge-date-index.js             pass
git diff --check c5c5754..a173d44                      pass
```

TODO 2件はPhase 2から継続する既知のbackfill idempotencyであり、本差分による追加ではない。

追加したfailure injection:

- season再親付け
- triggerを外した同数fixture ID差替え
- `INSERT OR REPLACE`による日付移動
- planのcompetition省略／取り違え／source key不一致
- invalid date／invalid canonical UTC instant
- root欠落／別competition merge
- authoritative fixture削除とcompetition限定削除
- degraded未知root/fixture field
- warm cacheに対するorigin拒否、rate limit、flag OFF

## Production cutover blocker

実装受入れのR2レビューは開始できるが、production cutoverは許可しない。

- Claude R2 PASS
- 対象環境へのmigration適用
- 実R2 object bytesと適用済みD1による全対象日coverage report
- canonical JSON/R2 bundle、Git補正定義、fixture catalog、parity coverage、readiness plan v2の整合
- staging failure injection、Cache API、D1 `rows_read`実測
- degraded TTL 60秒を跨ぐshadow compare監視と、切替後最低7日間の継続準備
- production flag変更の別途明示承認
