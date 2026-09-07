# D1 Phase 3 Core Read 実装レビュー結果 R3

- レビュー基準時刻: 2026-09-01 17:09 JST
- 対象branch: `feat/d1-phase3-core-reads`（Draft PR #95）
- code HEAD: `11db9dc020557ecae477f25cc24771efc9518a1d`
- branch HEAD: `c9b2a2459622f51a30689846602379548b99aee6`
- 対象range: `b9e359b62a7dfc823256eb543d37636921db48ff..c9b2a24`（`feat/d1-phase3-date-indexes` からの分岐点）
- 方式: fresh clone、実コード読解、in-memory `node:sqlite`への`0001`/`0002`/`0003`適用、実importerと実Workerを通したfailure injection

## Verdict

```text
Verdict: CHANGES_REQUIRED（レビュー未完了。未読領域あり）
BLOCKER: 0
MAJOR:   3（R2-001 / R2-002 / R2-004 — R2ラウンドからの持ち越し）
MINOR:   5（R2-005 降格 / R2-007 / R3-001 / R3-002 / R3-003 — 後3件は新規）

修正状態: 上記8件すべて修正済み・回帰確認済み（patch提示。リポジトリへは未適用）

統合レビュー完了:            NO
staging D1 migration 開始:  NO
production cutover 開始:    NO
```

feature flagは既定OFFで、Cloudflare環境・secret・deploy・flagは本差分で変更されていない。判定は実装受入れの保留であり、production露出済み欠陥ではない。

## 本ラウンドの主要所見

R2ラウンドで提示した修正がリポジトリに反映されていない。ハンドオフで「解消」と宣言された5件（R2-006 / 008 / 009 / 010 / 011）は実測で解消を確認したが、R2-001 / 002 / 004 / 005 / 007 は `c9b2a24` 時点で open のまま残っている。

レビュー結果は `docs/claude-review-result-<scope>-<date>-<round>.md` としてコミットする運用になっているが、Phase 3 R2 の結果docが `docs/` に存在しない（R1 と Codex R2 のみ）。取りこぼしはここで発生したと考えられる。本ドキュメントはその経路を復旧するために起こしている。

## 宣言値の照合

| 宣言 | 実測 | 判定 |
|---|---|---|
| `343 tests / 341 pass / 0 fail / 2 todo` | 完全一致 | OK |
| 43ファイル・約6,400行追加 | `43 files changed, 6402 insertions(+), 22 deletions(-)` | OK |
| code commit `11db9dc` / HEAD `c9b2a24` | 両commit実在。`11db9dc..c9b2a24` は docs 1ファイルのみ | OK |
| 15 commits | `git rev-list --count b9e359b..c9b2a24` = 15 | OK |
| Cloudflare環境・secret・deploy・flag未変更 | 差分に該当変更なし（`wrangler.toml.example` の追加のみ） | OK |
| GitHub CI run #456 success | GitHub API rate limit (403) により**独立確認できず** | 未検証 |

```text
node --test tests/*.test.js       343 tests / 341 pass / 0 fail / 2 todo
node --check worker/index.mjs     pass
git diff --check b9e359b..c9b2a24 pass
```

TODO 2件はPhase 2から継続するbackfill idempotencyであり、本差分起因ではない。

## 解消を確認したR2 findings

| finding | 判定 | 独立した確認 |
|---|---|---|
| D1P3-R2-006 | 解消 | 宣言commit `11db9dc` より先は docs 1ファイルのみ。検証範囲と宣言が一致 |
| D1P3-R2-008 | 解消 | `expectedTotals` は `Object.hasOwn` で明示必須。`fixedSnapshots` / `publishedFixtures` / `publishedStandings` / `dateIndexCoverages` / `competitionDateIndexCoverages` の5次元を全体 `COUNT(*)` と照合。`verifiedStandings` は40件チャンク＋scoped `WHERE` になり無制限スキャンは解消 |
| D1P3-R2-009 | 解消 | `v2-standings.yml` / `v2-date-feed.yml` / `v2-fixture-vertical-slice.yml` の3本すべてで mirror が `needs:` + `environment: d1-staging` の別jobへ分離。`ADMIN_INGEST_TOKEN` は当該jobのみに渡る |
| D1P3-R2-010 | 解消 | `fixture-bundle-importer.js` が `fixture.revision !== nextRevision`（連番必須）から `fixture.revision <= latestRevision` での拒否へ変更。欠番許容・巻き戻しのみ拒否となりR2が権威 |
| D1P3-R2-011 | 解消 | `revisionContent()` が全階層で `fetchedAt` / `reconciledAt` を除去して比較し、一致時は `structuredClone(current)` を返すため既存R2 bytesが維持される |

## 未解消のfindings

### [MAJOR] D1P3-R2-001 — standings publication が season 再親付けで失効しない

`migrations/0003_d1_standings_publication.sql` の失効triggerは `standings_groups` / `standings_rows` / `standings_snapshots` の3つのみで、`competition_seasons` に対する UPDATE trigger が存在しない。`0002` は同一クラスの穴を `date_index_coverage_invalidate_season_scope_update` で塞いでいるが、standings側へ横展開されていない。

実importerと実Workerを通した実測:

```text
import passed: true
before re-parent  PL     -> Premier League / teams af:team:40,af:team:50
UPDATE competition_seasons SET competition_id = 2 WHERE id = 1
publications after re-parent: 1
after  re-parent  LaLiga -> competition.name = "La Liga"
                            competition.id   = af:competition:140
                            teams            = af:team:40,af:team:50
route status: 200 | x-jfw-data-source: d1
```

La Liga のエンドポイントが Premier League の順位表を 200 / `d1` 権威 / degradedフラグなしで返す。`standingsIdentityDigestInput()` は group id と team id のみを入力とするため digest 照合も通過する。R1-001 と同一クラス。

### [MAJOR] D1P3-R2-002 — publication と snapshot の season 不一致が検出されない

`standings_publications.competition_season_id` と `standings_snapshots.competition_season_id` を突き合わせる制約が、スキーマにも Worker の `STANDINGS_ROWS_SQL` にも存在しない（`JOIN standings_snapshots snapshot ON snapshot.id = publication.snapshot_id` のみ）。`row_count` と `identity_digest` は参照先snapshot由来のため自己整合し、read-time検証では検出できない。

```text
cross-season publication accepted by schema: true
PL/af:season:39:2026 served -> af:team:541,af:team:529
```

### [MAJOR] D1P3-R2-004 — staging workflow の解決先ターゲットが未確認

`d1-staging-provision.yml` は `D1_DATABASE_NAME` / `D1_DATABASE_ID` を `vars.*` から取得するが、GitHub の environment 変数は environment 側に定義がなければ repo 側へフォールバックする。`environment: d1-staging` の宣言だけでは解決先が staging である保証にならない。`D1_TARGET_ENVIRONMENT` の宣言と解決値の確認が入っていない。

新設された mirror job の `ADMIN_INGEST_URL` にも同じ構造が当てはまる（R2-009 の分離自体は正しいが、解決先の保証は別問題）。

### [MINOR] D1P3-R2-005 — migration 内の `PRAGMA foreign_keys = ON`（MAJORから降格）

`0001` / `0002` / `0003` すべての1行目に残存。

**Cloudflare公式ドキュメントで解決した。scratch D1 での実測は不要になった。** D1 の外部キー強制は常に `PRAGMA foreign_keys = on` と等価であり、D1 はすべてのqueryを暗黙のtransaction内で実行するため、query や migration からこの設定を変更できない（https://developers.cloudflare.com/d1/sql-api/foreign-keys/）。したがってこの行は D1 ではno-opであり、エラーにもならない。migration適用をブロックする要因ではない。

**ただし、より重大な派生事実がある。** D1 では外部キーを無効化できないため、`PRAGMA defer_foreign_keys` で検査を遅延させても `ON DELETE CASCADE` は即座に発火する。CHECK制約の変更にはテーブル再構築が必要であり、D1 上で再構築を行うと子テーブルが黙って削除される。`date_index_coverages` は `competition_date_index_coverages` から `ON DELETE CASCADE` で参照されており、まさにこの形をしている。

**運用上の結論: 下記 R2-007 の CHECK 修正は、`0002` / `0003` をいずれの環境にも適用する前に取り込むこと。** 適用後に修正しようとすると、テーブル再構築によるデータ消失の経路に入る。

**R2ラウンドの記述を訂正する。** 「テスト17ファイルがこの1行にFK有効化を依存している」と述べたが、実測の結果 `node:sqlite` の `DatabaseSync` は migration 適用前から `foreign_keys = 1` であった（Node側の既定がON）。PRAGMA を除去してもローカルテストのFK検証は無効化されない。除去のリスクは当初評価より小さい。

**修正**: PRAGMA行は除去せず（ローカルSQLite driverが外部キーOFF既定だった場合の保険として残す）、D1でのno-op性・無効化不能性・`defer_foreign_keys`との違いをコメントで明記した。あわせて、migration適用後に外部キー強制が実際に有効であることを確認する回帰テストを追加した。

### [MINOR] D1P3-R2-007 — CHECK が NULL で成立する穴（`0003` へ増殖）

SQLite の CHECK は式が NULL のとき成立扱いになるため、`date(x,'+0 days') = x` / `strftime(...) = x` では存在しない日付・instant が素通りする。R2ラウンドと同一の測定値が再現した。

```text
date_index_coverages.date_jst      '2026-13-01'                ACCEPTED
date_index_coverages.date_jst      '2026-19-01'                ACCEPTED
date_index_coverages.date_jst      '2026-09-32'                ACCEPTED
date_index_coverages.date_jst      '2026-02-30'                rejected
date_index_coverages.generated_at  '2026-13-01T00:00:00.000Z'  ACCEPTED
```

加えて新規の `0003` の `standings_publications.generated_at`（85行目）が同じ `=` パターンを踏襲しており、`2026-13-01T00:00:00.000Z` が ACCEPTED であった。

### [MINOR] D1P3-R3-001 — `competition_season_teams` の bound parameter が無制限（新規）

`admin-worker/index.mjs` の standings 書込みで、`competition_season_teams` への INSERT だけが chunk されておらず、チーム数に比例して bound parameter が増える。D1 の上限は1 queryあたり100（https://developers.cloudflare.com/d1/platform/limits）。

同一関数内の他のINSERT（`teams` / `standings_groups` / `standings_rows`）はすべて chunk されており、この1箇所だけが漏れている。

実測（statementごとの bound parameter 数）:

```text
20 teams / 1 group  (典型的なリーグ)      statements= 20 maxParams= 100 over100=0
36 teams / 1 group  (UCL league phase)   statements= 29 maxParams= 100 over100=0
48 teams / 1 group                       statements= 36 maxParams= 100 over100=0
51 teams / 1 group                       statements= 38 maxParams= 102 over100=1
    -> competition_season_teams: 102 params
```

51チーム以上の standings で publish batch 全体が abort する。fail closed であり破損はしないが、当該competitionは恒久的に移行できなくなる。60チームでの回帰テストを追加し、修正前は `a statement bound 120 parameters` で失敗することを確認した。

**修正**: 40件ずつ chunk（80 params）。

**観測**: 他のchunk sizeは `teams` 20×5、`standings_groups` 20×5 がいずれもちょうど100 paramsで、上限に余裕がない。列を1つ追加すると即座に超過する。今回は修正対象にしていないが、chunk sizeの見直しを推奨する。

### [MINOR] D1P3-R3-002 — fixture detail のR2契約が閉じておらず未知フィールドが素通り（新規）

`worker/index.mjs` の `assertFixtureDetailPayload()` は必須項目の形と identity を検証するが、**ルートフィールドの許可リストを持たない**。standings（`assertValidStandingsPayload`）と date index（`assertValidDateIndexPayload`）は閉じた契約になっており、fixture detail だけが開いている。

R1-007 と同一クラスだが範囲が広い。`r2FixturePayload()` は degraded 経路だけでなく通常の `r2` 経路と `r2-not-migrated` 経路も通るため、D1未移行の全fixtureが対象になる。D1経路は `scripts/d1/fixture-dto.js` が列から再構成するため構造的に閉じており、注入が起きるとD1とR2でDTOが一致しなくなり parity 検証をすり抜ける。

実測（D1を落として degraded に落とした状態）:

```text
--- standings ---
  unknown ROOT field    -> 503 / unavailable | leaked=false
  unknown NESTED field  -> 503 / unavailable | leaked=false

--- fixture detail ---
  unknown ROOT field    -> 200 / r2-degraded | leaked=true
  unknown NESTED field  -> 200 / r2-degraded | leaked=true
```

**修正**: 閉じたルートキー集合 `FIXTURE_DETAIL_ROOT_FIELDS` を追加。集合は推測ではなく両側から実測して確定した — `normalizeFixtureBundle()` に実データ形状を通した出力（12キー）と、`buildAvailableBundle` / `buildUnavailableBundle` の出力が完全一致することを確認している。回帰テストで両者の一致を継続的に固定した。

### [MINOR] D1P3-R3-003 — fixture整合ゲートが `lifecycle_state` のCHECK幅に依存（新規）

`addIntegrityStatement()` は整合性違反時に `lifecycle_state = 'invalid'` を書き、`0001` の `CHECK (lifecycle_state IN ('staging','published','superseded'))` 違反で batch を abort させる。直後の `addPublishStatements()` は無条件に `'published'` で上書きする。

lifecycle state を1つ増やすのは通常のスキーマ進化であり、`'invalid'` が許可状態に加わった瞬間にゲートは無音の no-op になる。実測:

```text
CHECK allows 'invalid' = false -> batch aborted = true  | final lifecycle_state = "staging"
CHECK allows 'invalid' = true  -> batch aborted = false | final lifecycle_state = "published"
```

**修正**: センチネルを `created_at` へ移動。`created_at` のCHECKはタイムスタンプ書式（`GLOB '????-??-??T??:??:??*Z'`）であり、任意文字列を許すように広げられることはない。date-index と fixed-snapshot の同種ゲートも `sync_runs.started_at` の同じ書式CHECKに依存しているため、3つのゲートが同一の土台に揃う。CHECKを広げた状態の回帰テストを追加し、修正前のコードで失敗することを確認した。

### [MINOR] D1P3-R3-004 — date index coverage の competition scope をpayloadから再導出（新規・予防的）

`publishDateIndexCoverageFromR2()` は coverage 行のキーとなる competition ID を `artifact.payload.competition.id` から取得していた。現状は `assertValidDateIndexPayload` が宣言scopeとの一致を強制しているため悪用可能ではないが、scopeを制約する対象の文書からscopeを再導出する構造であり、R1-002 / Phase2 R4-001 と同じ自己参照クラスにあたる。

**修正**: 宣言された `competitionIds` を `declaredCompetitionId` として artifact に随伴させ、そちらをキーに使用。payload側との不一致は明示的に throw する。

## 検証済みの修正

R2-001 / 002 / 004 / 005 / 007 および R3-001 に対する修正を作成し、実測で確認した。リポジトリへは未適用。

- `0003`: `competition_seasons` の `competition_id` / `canonical_id` 変更、および `competitions.canonical_id` 変更で publication を失効させる trigger を追加（`0002` の既存パターンに準拠）
- `0003`: publication と snapshot の season 不一致を `RAISE(ABORT)` で拒否する INSERT / UPDATE trigger を追加
- `worker/index.mjs`: `STANDINGS_ROWS_SQL` の `JOIN standings_snapshots` に `AND snapshot.competition_season_id = publication.competition_season_id` を追加（書込み側と読込み側の二重防御）
- `0002` 3箇所 / `0003` 1箇所: CHECK の `=` を `IS` へ変更
- `scripts/d1/render-admin-wrangler.mjs`: `D1_TARGET_ENVIRONMENT` を必須化。GitHub は environment に定義がなければ repository変数へフォールバックするため、**environment scope にのみ定義する変数**を必須にすることで、repository defaults で解決された実行を hard fail させる。あわせて `D1_DATABASE_NAME` / `ADMIN_WORKER_NAME` が宣言された環境名を含むことを要求する
- `.github/workflows/d1-staging-*.yml` 3本: `D1_TARGET_ENVIRONMENT` を渡し、provision では解決値をログに出力する
- `migrations/0001`〜`0003`: PRAGMA の D1 における意味をコメントで明記
- `admin-worker/index.mjs`: `competition_season_teams` INSERT を40件ずつ chunk

```text
R2-001  publications after re-parent      1        -> 0
        route status / data-source        200 / d1 -> 404 / r2-not-migrated
R2-002  cross-season publication          ACCEPTED -> rejected (RAISE ABORT)
R2-007  date_jst '2026-13-01'             ACCEPTED -> rejected
        date_jst '2026-19-01'             ACCEPTED -> rejected
        date_jst '2026-09-32'             ACCEPTED -> rejected
        generated_at '2026-13-01T..'      ACCEPTED -> rejected

R2-004  D1_TARGET_ENVIRONMENT未宣言        素通り   -> throw
        production宣言                    素通り   -> throw
        DB名が宣言環境と不一致              素通り   -> throw
R3-001  60 teams の最大bound parameter     120      -> 80
R3-002  未知ROOTフィールドのクライアント到達   leaked   -> 503 / unavailable
R3-003  CHECKを広げた状態でのゲート          no-op    -> abort 維持

node --test tests/*.test.js   343 tests / 341 pass -> 354 tests / 352 pass / 0 fail / 2 todo
node --check ×5               pass
git diff --check              pass
```

差分は15ファイル・364行追加・18行削除（うちテスト235行）。回帰テストはいずれも修正前のコードで失敗することを確認済み。

**適用前提**: `0002` / `0003` は実環境未適用であることを前提に in-place 修正している。ローカルに `0002` / `0003` を適用した開発用DBが残っている場合は作り直しが必要。stagingを含む実環境へ適用済みであれば in-place を差し戻し、`0004` 追加へ切り替えること。

## 観測（finding化していないもの）

1. season 再親付け後、**元の** competition でリクエストすると `buildD1Standings` が `D1 competition season is not stored.` を throw する一方、新しい competition 側は 404 `r2-not-migrated` を返す。いずれも fail closed であり実害は確認できていないが、経路が非対称である。

2. degraded 応答は `lastSuccessfulAt: payload.generatedAt` を付与するが、**fixture bundle 契約にルート `generatedAt` は存在しない**（`normalizeFixtureBundle()` の出力で実測確認）。standings と date index には存在する。結果として fixture の degraded 応答だけ `lastSuccessfulAt` が常に `undefined` となりJSONから消える。`fixture.reconciledAt` が実質的な同等値だが、**公開レスポンスの形が変わる**ため本ラウンドでは修正していない。判断を要する。

3. `teams` と `standings_groups` の chunk size は 20×5 でちょうど100 params であり、上限に余裕がない。列が1つ増えると即座に超過する。

## 本ラウンドで確認できていない領域

以下は未確認であり、この時点で `PASS` は出せない。

1. `admin-worker/fixed-snapshot-ingest.mjs` の再実行冪等性 — `assertExistingImport` の全体件数照合はコード読解で確認したが、部分書込み後の再実行は未実測
2. `scripts/d1/request-admin-ingest.mjs` の部分書込み後 retry 冪等性 — fail-fast（`skipped_after_failure`、exit 1、`productionReady: false` ハードコード）と `migration_verify` の末尾配置は確認済み
3. partial write / repeated migration の実測
4. R1-004 / R1-006 の独立probe
5. GitHub Actions run #456 の独立確認（GitHub API rate limit により未実施）

### 本ラウンドで確認し、問題がなかったもの

- admin ingest client の fail-fast と `migration_verify` の実行順序
- plan の重複scope検出（identity集合サイズ比較）
- endpoint検証（認証情報付きURL拒否、HTTPS必須、path/search/hash の強制上書き）
- `fixed-snapshot-ingest.mjs` の bound parameter（14×4 / 16×6 / 12×7 / 10×5、いずれも上限内）と `MAX_BOOTSTRAP_STATEMENTS` 45 の予算検査
- fixed snapshot の `artifactSha256` / `byteSize` はいずれも `stableStringify` の正規形から導出されており整合している
- standings degraded 経路の未知フィールド拒否（R1-007解消済みを再現確認）
- fixture detail の R2 degraded 経路と同一fixture identity検証

## 次の作業

1. 本ラウンドの修正patchを適用する。`0002` / `0003` の CHECK 修正は、いずれの環境にも適用する**前**に取り込むこと（R2-005の派生事実を参照）。
2. GitHub の `d1-staging` environment に `D1_TARGET_ENVIRONMENT = staging` を**environment scope でのみ**定義する。repository scope には定義しない。
3. 未確認領域8項目を含む統合レビューを1回実施する。
4. 統合レビュー PASS 後に Cloudflare staging 環境を作成し `0001`〜`0003` を適用する。
5. 実R2 artifact を admin ingest へ渡し、完全件数宣言・identity・semantic parity report を保存する。
6. staging で4 endpoint の failure injection と rows read を計測する。
7. staging flag は明示承認後にのみ変更する。production flag は別途承認されるまで変更しない。

現状の `c9b2a24` のまま統合レビューを実施しても、既知の open 4件を再掲する結果にしかならない。1と2を先に片付けること。

## レビュー範囲

SYUUHEIの明示指示により、本ラウンドは修正を含む。ただし merge、push、deploy、feature flag変更、Cloudflareリソース操作はいずれも行っていない。修正はレビュー用cloneのローカルブランチ上でのみ検証し、patch として別途提示している。
