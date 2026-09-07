# D1 Phase 3 R4 独立レビュー結果

- レビュー基準時刻: 2026-09-02 14:21 JST
- 基準コミット: `c9b2a2459622f51a30689846602379548b99aee6`
- 対象: `d1-phase3-r3-fixes.patch` + `d1-phase3-r4-fixes.patch`
- 実装: Codex（Chappy）
- レビュー: Claude（本ラウンドの実装には関与していない）
- 方式: fresh clone、両patchの `git am` 適用、全テスト再実行、実データ形状での網羅プローブ、target verification の独立プローブ

## Verdict

```text
Verdict: CHANGES_REQUIRED
BLOCKER: 0
MAJOR:   0
MINOR:   1（D1P3-R4-001 新規）

D1P3-R3-005: 解消
D1P3-R3-006: 実質解消（dynamic map 4箇所は設計判断として維持）
D1P3-R3-007: 解消（副作用の観測1件、修正対象として合意済み）

staging D1 migration:  R5の独立確認後
production cutover:    NO
```

R3ラウンドはClaudeが実装とレビューを兼ねた結果 R3-006 を誤って解消と判定した。本ラウンドは実装と検証を分離しており、R4パッチの品質はR3ラウンドのClaude実装より明確に高い。

## 宣言値の照合

| 宣言 | 実測 | 判定 |
| --- | --- | --- |
| baseline `343 tests / 341 pass / 0 fail / 2 todo` | 一致 | OK |
| R3+R4 `372 tests / 370 pass / 0 fail / 2 todo` | 一致 | OK |
| R3パッチが未改変 | `cmp` でClaudeの出力とバイト一致 | OK |
| `git am` clean | R3・R4とも conflict なし（計6コミット） | OK |
| `git diff --check` | pass | OK |
| Cloudflare deploy / secret / flag 未変更 | 差分に該当変更なし | OK |

R4差分は17ファイル・1,265行追加・122行削除。

### anti-failure の抜き取り確認

実装のみR3時点（`42c7ade`）へ戻し、R4のテストを適用した状態で実行:

```text
tests/d1-fixture-worker.test.js + tests/d1-migration-workflows.test.js
  R3実装 + R4テスト  ->  32 tests / 10 pass / 22 fail
  R4実装 + R4テスト  ->  32 tests / 32 pass /  0 fail
```

追加テストが実際に欠陥を検出していることを確認した。

## D1P3-R3-005 — 解消

`verifyD1Target()` を独立にプローブした。8ケースすべてが期待通りに動作する。

```text
exact valid target               -> ACCEPTED
prod-like DB name                -> rejected
prod-like DB uuid                -> rejected
other worker                     -> rejected
other bucket                     -> rejected
other origin                     -> rejected
origin w/ same host diff scheme  -> rejected
missing url                      -> rejected
staging-named but wrong uuid     -> rejected
```

最後のケースが本質的である。R3でClaudeが実装した「リソース名に環境名を含む」検査ではこれが通過していた。exact match への置換により、GitHubの `vars` context の provenance 仕様に依存しない構造になった。R3-005の指摘1は、provenance を根拠にしない設計へ移行したことで論点自体が解消している。

`.includes(targetEnvironment)` の削除がテストで固定されている点も適切である。6本すべてのworkflowで proof が最初の書込みより前に配置されていることを、実ファイルとテストの双方で確認した。R3で dead variable だった `D1_TARGET_ENVIRONMENT` は削除され、その不在がテストで固定されている。

## D1P3-R3-006 — 実質解消

### 検証方法

R3ラウンドの検証失敗を繰り返さないため、`normalizeFixtureBundle()` に実プロバイダ形状を通した公開アーティファクト形状を基点とした。全実行で clean ケースの `200 / r2-degraded` または `200 / r2-not-migrated` を先に確認し、固定オブジェクトと配列要素の全38箇所へ未知キーを注入した。

```text
=== not-migrated ===  clean -> 200 / r2-not-migrated
  38箇所中 34箇所が fail-closed
=== degraded ===      clean -> 200 / r2-degraded
  38箇所中 34箇所が fail-closed
```

R3時点では nested が全箇所素通りしていた。生成schemaによる再帰的な閉鎖は有効に機能している。

### 残余 — dynamic map 4箇所（設計判断として維持）

```text
teamStats[].values    -> 200 | leaked=true
playerStats[].values  -> 200 | leaked=true
overrides             -> 200 | leaked=true
fieldIssues           -> 200 | leaked=true
```

SYUUHEIの判断により現設計を採用する。

- `teamStats[].values` / `playerStats[].values` — 未知のprovider statを保持する公開extension map
- `overrides` / `fieldIssues` — field path をキーとする公開correction map

これら4箇所のキーは閉じない。固定DTOの未知fieldとは区別する。値側は生成schemaによる制約を維持する。D1経路も同一の開放性を持つため、D1/R2のparityは損なわれていない。この設計判断は契約文書に明記すること。

## D1P3-R3-007 — 解消

`lastSuccessfulAt` は `fixture.reconciledAt` から設定されるようになった。fixture bundle のルートに `generatedAt` が存在しないことは `normalizeFixtureBundle()` の出力で確認済みであり、`reconciledAt` を採用する判断は妥当である。

### 観測（R5で修正）

degraded経路に `reconciledAt` の書式検査が追加され、ミリ秒付きISO以外の場合に503を返す。表示用フィールドが可用性ゲートになっており、degraded経路の目的に反する。SYUUHEIの判断により、canonical な場合のみ `lastSuccessfulAt` を付与し、欠落・不正時は当該フィールドを省略して degraded 配信を継続する。

## D1P3-R4-001 — MINOR — flag OFF 経路が無検証（新規）

`D1_FIXTURE_DETAIL_ENABLED` が false のとき、`fixtureFromR2()` は `r2JsonObject()` を経由してR2のbytesをそのまま返す。`assertFixtureDetailPayload()` は呼ばれない。

```text
=== flag-off ===  clean -> 200 / (x-jfw-data-source ヘッダなし)
  38箇所すべて leaked=true
```

これは既定flagで使われる公開経路である。R3・R4が導入した回帰ではなく既存の挙動だが、閉じた契約はflagをONにして初めて効果を持つ。SYUUHEIの判断により、flag OFFでもclosed contractで検証し、raw bytesを無検証で返す経路を廃止する。

### R5実装時の注意

この変更は公開経路の挙動を変える。実在するR2アーティファクトのいずれかがclosed contractを満たさない場合、fixture detailが停止する。合成payloadでの検証だけでは不十分であり、実在するR2アーティファクト形状に対して検証すること。少なくともcontract 2.0.0と2.1.0の双方、および`overrides` / `fieldIssues`が空でないケースを含めること。

## config/d1-targets.json の識別子

Claudeは値を独立に検証できない。以下はSYUUHEIの確認に基づく記録である。

| 値 | 状態 |
| --- | --- |
| `d1DatabaseName: jfw-football-staging` | 2026-09-02 にSYUUHEIがCloudflare Dashboard上で作成・確認した実在D1 |
| `d1DatabaseId: fdfd74e4-2702-4aa2-ab20-c062e952fe25` | Dashboard表示値 |
| `r2BucketName: jfw-football-data` | Dashboardで確認済み |
| `adminWorkerName: jfw-football-admin-ingest-staging` | 確定した名称。未デプロイ |
| `adminEndpointOrigin: https://jfw-football-admin-ingest-staging.ssdkllpd.workers.dev` | 実在確認済みURLではなく、Worker名とアカウントサブドメインから定めたprovisioning target |

`adminEndpointOrigin` がprovisioning targetである点は実装レポートと一致している。不一致時は書込み前にfail closedするため、安全側に倒れている。

### 追跡が必要な項目

staging provisionの実行後、実際にデプロイされたWorkerのURLがmanifestの`adminEndpointOrigin`と厳密に一致することを確認する。proof stepは`vars.ADMIN_INGEST_URL`をmanifestと照合するのみで、デプロイされたWorkerの実URLは照合しない。workers.devサブドメインが無効化されている場合やカスタムドメインを使う場合、実URLはmanifestと異なる。

## 本ラウンドで確認していない領域

- GitHub Actions 上での実行挙動（workflow の静的検証のみ実施）
- Cloudflare 実環境での migration 適用と実データ投入
- `admin-worker/fixed-snapshot-ingest.mjs` の部分書込み後の再実行冪等性（実測未了。コード読解は完了）
- partial write / repeated migration の実測

## 次ラウンド（R5）の合意スコープ

以下に限定する。R3-005を含む解消済み項目をゼロから再レビューする必要はない。

1. flag OFF 経路の契約検証
2. 不正 timestamp 時の degraded 配信継続
3. dynamic map 設計の契約文書への明記
4. 既存回帰（全テストスイート）

ただし1については、実在R2アーティファクト形状での検証を受入条件に含める。合成payloadのみの検証では受け入れない。

staging D1 migrationはR5の独立確認後まで実行しない。production cutoverは引き続き対象外。

## レビュー範囲

read-only。本ラウンドでClaudeはコードを一切変更していない。merge、push、deploy、feature flag変更、Cloudflareリソース操作はいずれも行っていない。
