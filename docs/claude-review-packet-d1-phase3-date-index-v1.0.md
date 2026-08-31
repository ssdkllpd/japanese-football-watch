# Claude review packet — D1 Phase 3 date indexes v1.0

更新日: 2026-08-31

## レビュー対象

- repository: `ssdkllpd/japanese-football-watch`
- branch: `feat/d1-phase3-date-indexes`
- base: `be581039bd0bc561353bd486ec2bc891875d77ce`
- code HEAD: `dcd68f23922cf6cc85a4ea2474a2d268f7f86863`
- code range: `be58103..dcd68f2`

packet自身と実装説明はcode HEAD後のdocs-only commitに置く。コードレビュー範囲は上記rangeに固定する。

## 前提

Phase 2 R5の正式判定はPASSで、Phase 3 implementation may startはYES、Production cutover may startはNO。R5のMINOR 2件とlocale順序の観察事項はPhase 2 branchの`44a94cd`で修正済みであり、本base `be58103`に含まれる。

本差分はPhase 3順序の第1項、date / competition indexesだけを実装する。feature flagは既定OFFで、deployやproduction flag変更は行っていない。

## 変更file

| file | 内容 |
|---|---|
| `worker/index.mjs` | D1 query、DTO builder、endpoint flag、R2 degraded fallback |
| `worker/wrangler.toml.example` | D1 binding例、2つのflagを`false`で追加 |
| `tests/v2-worker.test.js` | migration実適用、query plan、DTO、flag、failure injection |

## 重点レビュー項目

1. flag未設定／OFF時に既存R2経路が変わらず、D1 readが0回であること。
2. 日付一覧が1 query、大会別日付一覧が2 query以内で、各専用indexを使い`fixtures`全表走査をしないこと。
3. D1 rowを公開せず既存date index DTOへ投影し、明示的な`0`、`false`、`null`を保持すること。
4. 2 endpointのflagが独立し、片方の切替が他方へ波及しないこと。
5. D1 error時にretryせず、同一dateまたは同一competition/dateのR2 keyだけへfallbackすること。
6. fallback payloadのcontract/timezone/date/competition/fixture scope/最終成功時刻をruntimeで検証し、別entityや不正objectを503で拒否すること。
7. D1上でcompetitionが存在しない正常404を障害fallbackと混同しないこと。
8. `x-jfw-data-source`、`degraded`、`lastSuccessfulAt`によりD1成功／degraded／利用不能を判別できること。
9. standings、fixture detail、LIVE、tracking read pathおよびproduction cutover条件を開いていないこと。

## 実測値

```text
node --test tests/v2-worker.test.js
14 tests / 14 pass / 0 fail

node --test tests/*.test.js
265 tests / 263 pass / 0 fail / 2 todo

node --check worker/index.mjs
pass

git diff --check be58103..dcd68f2
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

このレビューで許可対象にできるのは実装の受入れまでである。実データ統合readiness、staging failure injection、最低7日間のshadow運用準備、別途の明示承認が揃うまではproduction flagを変更しない。
