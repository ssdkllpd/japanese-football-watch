# D1 Phase 3 date index implementation v1.0

更新日: 2026-08-31

## 状態

Phase 2 R5の正式レビューPASSに基づき、Phase 3の最初の単位である日付別／大会別日付一覧のD1 read pathを実装した。これは実装とテストまでであり、productionのflag変更、Worker deploy、正本切替は行っていない。

```text
Implementation: COMPLETE
Feature flags: OFF by default
Production cutover: NOT AUTHORIZED
```

## 対象endpointとrollback

| endpoint | D1 flag | 既定値 | rollback |
|---|---|---:|---|
| `GET /api/v2/dates/{date}` | `D1_DATE_INDEX_ENABLED` | `false` | flagを`false`へ戻す |
| `GET /api/v2/competitions/{competitionId}/dates/{date}` | `D1_COMPETITION_DATE_INDEX_ENABLED` | `false` | flagを`false`へ戻す |

2つのflagは独立している。flag未設定または`false`では既存R2 keyとresponse pathをそのまま使い、D1 bindingを読まない。standings、fixture detail、LIVE、tracking aggregatesには変更を加えていない。

## D1 read contract

- 日付一覧は1 queryで`idx_fixtures_date_kickoff`を使用する。
- 大会別日付一覧はcompetition identity 1 queryとfixture 1 queryの合計2 queryで、fixture queryは`idx_fixtures_competition_date_kickoff`を使用する。
- いずれも`EXPLAIN QUERY PLAN`で`fixtures`の全表走査がないことを回帰testで固定する。
- 内部rowはそのまま公開せず、既存2.0 date indexと同じDTOへ投影する。
- scoreの明示的な`0`、欠落の`null`、winnerの`true` / `false` / `null`を区別する。D1 booleanは`0` / `1`以外を受理しない。
- D1成功応答は`x-jfw-data-source: d1`、TTL 300秒とする。

`generatedAt`はD1 factsの更新時刻ではなく、Workerがdate feed responseを構築した時刻である。shadow compareではこのresponse metadataをfact parityの対象にしない。

## D1 failureとdegraded fallback

D1 readはretry loopを作らず、失敗時に要求されたものと同じR2 alias keyだけを読む。

| 条件 | response |
|---|---|
| 同じentityの検証可能なR2 snapshotあり | `200`、`degraded: true`、`lastSuccessfulAt`、`x-jfw-data-source: r2-degraded` |
| R2 bindingなし／objectなし／JSON不正 | `503`、`x-jfw-data-source: unavailable` |
| contract、timezone、date、competition、fixture scope、`generatedAt`不一致 | `503`、`x-jfw-data-source: unavailable` |
| D1 query成功だがcompetitionが存在しない | `404`、`x-jfw-data-source: d1`。R2へfallbackしない |

R2 snapshotはruntimeでも次を検証する。

- `contractVersion === "2.0.0"`
- `timeZone === "Asia/Tokyo"`
- root `date`が要求dateと一致
- `fixtures`が配列
- `generatedAt`が有効な日時
- 各fixtureの`dateJst`が要求dateと一致
- 大会別endpointではroot competition IDと各fixture competition IDが要求IDと一致

これにより、別日・別大会・壊れたobjectをdegraded成功として返さない。degraded応答のTTLは60秒とする。

## 検証証跡

実行環境: Node v22、`node:sqlite`のin-memory databaseへ`migrations/0001_d1_core.sql`を適用。

```text
node --test tests/v2-worker.test.js
14 tests / 14 pass / 0 fail

node --test tests/*.test.js
265 tests / 263 pass / 0 fail / 2 todo

node --check worker/index.mjs
pass

git diff --check
pass
```

TODO 2件はPhase 2から継続する既知のbackfill idempotencyであり、date index差分による追加ではない。

failure injection testは次を固定する。

- generic dateのD1例外から同じdate R2 snapshotへfallback
- competition-dateのD1例外から同じcompetition/date R2 snapshotへfallback
- fallback object欠落時は503
- 別date snapshotはentity validationで503
- D1上の未知competitionは404で、無関係なR2を読まない

## production cutover前の残作業

1. 本差分の独立レビューをPASSにする。
2. canonical JSON/R2 bundle、Git補正定義、fixture catalog、適用済みD1、reconciled coverage、readiness plan v2による実データ統合reportを通す。
3. stagingでD1 failure injectionを再実行し、実R2 degraded snapshotと観測情報を確認する。
4. endpoint単位のsemantic shadow compareを開始し、切替後も最低7日間継続できる監視を用意する。
5. production flag変更について別途明示承認を得る。

上記が揃うまで2つのflagは`false`のままとし、production cutoverを行わない。
