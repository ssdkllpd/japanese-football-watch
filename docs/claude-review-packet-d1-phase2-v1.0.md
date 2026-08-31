# D1 Phase 2 implementation — Claude formal review packet v1.0

状態: **R5 PASS — PHASE 3 IMPLEMENTATION AUTHORIZED — PRODUCTION CUTOVER BLOCKED**

対象branch: `fix/d1-phase2-review-r2`

初回レビュー対象HEAD: `3f9fe90ffa5ccad8c21b478180619114c7702c61`

R1修正対象HEAD: `0e74f2c0e479b0fb7720c4d51f614d6b900027de`

R2修正対象HEAD: `afd2767a58f9861914c7a569afa2080efd0fdb83`

R3修正対象HEAD: `12baf4f8629ce4b70d879a8d60805cd9ab663fc7`

R4修正対象HEAD: `ad2758d`

R5 MINOR修正対象HEAD: `44a94cd`

初回レビュー結果: `docs/claude-review-result-d1-phase2-2026-08-30.md`

R2レビュー結果: `docs/claude-review-result-d1-phase2-2026-08-30-r2.md`

R3レビュー結果: `docs/claude-review-result-d1-phase2-2026-08-30-r3.md`

R4レビュー結果: `docs/claude-review-result-d1-phase2-2026-08-30-r4.md`

R5レビュー結果: `docs/claude-review-result-d1-phase2-2026-08-31-r5.md`

## 1. レビュー目的

D1 Phase 1/2実装が、承認済みのD1/R2設計とfail-closed migration規則を満たしているかを独立に確認する。今回のレビューはPhase 3 endpoint切替の前提条件であり、runtime正本の切替そのものは対象外とする。

レビュー対象は次の3点である。

1. 固定snapshotからD1へ移すCore facts、tracking、Rating、aggregateで、ID・revision・期間・`0`・`null`・欠落が保持されること。
2. JSON/R2正本と公開D1 revisionのsemantic shadow、record linkage、fact parityが保存済みreportを信用せず再検証されること。
3. 6つの技術gateがすべて通るまで、`productionReady`と`phase3CutoverReady`が常に`false`のままであること。

## 2. 対象commit

| Commit | 内容 |
|---|---|
| `13db235` | reviewed D1 Core schema |
| `eb05c9a` | fixture DTO parity correction |
| `0b773f8` | D1 fixture shadow repository |
| `7b00c93` | fixed snapshot importer |
| `269cce7` | fixture coverage manifest |
| `abec759` | semantic fixture shadow compare |
| `8cd1bd7` | batch shadow reports |
| `6c3b185` | canonical fixture bundle importer |
| `805d3b2` | batch canonical fixture import |
| `240b9aa` | legacy record to canonical fixture linkage |
| `de50444` | canonical fixture fact parity |
| `e25caa8` | exact tracked-player crosswalk preflight |
| `a93a8e8` | verified crosswalk application |
| `6917c73` | authored JFW Rating migration |
| `62e9507` | verified tracked-player aggregate rebuild |
| `3f9fe90` | integrated read-only Phase 2 readiness verification |
| `0e74f2c` | Claude findings: expected scope、order parity、correction provenance、constraints |
| `afd2767` | R2 findings: snapshot-derived scope、event round-trip order、import-time correction parity |
| `12baf4f` | R3 findings: identity-only player parity、event order uniqueness、index test alignment |
| `ad2758d` | R4 findings: lossless legacy aggregate parity、identity-only scope-set validation、failure-branch tests |
| `44a94cd` | R5 MINOR findings: aggregate verification metadata、cross-season scope rejection、deterministic ordering |

主な実装・仕様ファイル:

- `migrations/0001_d1_core.sql`
- `scripts/d1/`
- `tests/d1-*.test.js`
- `docs/data-storage-d1-r2-design-v1.0.md`
- `docs/d1-local-import-runbook-v1.0.md`

## 3. 統合readiness gate

`scripts/d1/verify-phase2-readiness.js`は次の6 gateをread-onlyで再計算する。

| Gate | 合格条件 |
|---|---|
| `fixtureRecords` | snapshot全`playerMatchStats`から導出した`fixtureRecordIds`全件が公開D1 appearanceへ一意にlinkされ、比較可能な全fact parityがpassed |
| `fixtureShadows` | scoped fixtureのJSON/R2、公開D1、独立Git補正定義が一致し、event/lineup entry順も一致 |
| `trackedPlayerIdentities` | recordなしplayerが未解決identityのままで、tracking属性、legacy membership、legacy season aggregateが固定snapshotと一致 |
| `trackedPlayerCrosswalks` | snapshot recordから導出した`trackedPlayerIds`全員と全membership期間がprovider evidenceどおりのCore identityへresolved |
| `jfwRatings` | snapshotのRating宣言から導出した`ratingRecordIds`全件がauthored値・null状態・source hash・公開revisionと一致 |
| `trackedPlayerAggregates` | `trackedPlayerIds`と同一に導出した`aggregatePlayerIds`全員の期待scopeが値・null・欠落・source hash・scope identityまで一致 |

6 gateの論理積だけが`phase2TechnicalGatePassed`になる。evaluatorは外部レビュー結果を自動取得しないため、技術gate通過後も次を維持する。R5の正式レビューPASSはPhase 3実装着手だけを別途許可し、production cutoverは許可しない。

```json
{
  "productionReady": false,
  "phase3CutoverReady": false,
  "remainingGates": ["claude_formal_review"]
}
```

## 4. レビュー履歴と修正結果

初回Codex自己レビューのBLOCKER 0 / MAJOR 0判定は撤回する。Claude実データレビュー結果は次のとおり。

Verdict: **CHANGES_REQUIRED**

BLOCKER: 2

MAJOR: 3

MINOR: 4

全findingを`0e74f2c`で反映済み。主な修正:

- plan v2でfixture record、crosswalk player、Rating record、aggregate playerの期待分母を必須宣言する。
- scope外は`not_applicable`、scope内の証拠不足は`deferred`として分離する。
- eventとlineup entryの配列順をparity対象に戻し、D1へ`entry_order`を保存する。
- 補正はGit定義、JSON/R2、D1の三者照合とし、比較JSONからの定義注入を廃止する。
- link+parityはreadiness実行中に1回だけ再計算し、各verifierで共有する。
- tracking statusへDB CHECKを追加する。

R2レビューは`CHANGES_REQUIRED`（BLOCKER 1 / MAJOR 2 / MINOR 5）。`afd2767`で次を反映した。

- 4つのexpectation集合を固定snapshotから導出し、planの過少・過大宣言を完全一致validationで拒否する。
- fixture parityはsnapshot全120 record、crosswalk／aggregateはrecordを持つ55 player、Ratingは宣言済み55 recordを分母とする。
- eventsを`event_order`単独で復元し、source JSONの配列順をround-tripする。
- Rating件数をproduct seasonと`rating_version`の両方で照合する。
- `entry_order`のDEFAULTを外し、ordered array比較をcontract pathに限定する。
- canonical fixture importでGit補正定義fileを必須にし、bundleとの一致をtransaction開始前に検証する。

R3レビューは`CHANGES_REQUIRED`（BLOCKER 0 / MAJOR 1 / MINOR 2）。`12baf4f`で次を反映した。

- recordなし9 player専用の`trackedPlayerIdentities` gateを追加した。
- 9 playerの未解決crosswalk、tracking属性、legacy membership、legacy season aggregateを固定snapshotと完全照合する。
- match evidenceがない正常状態を`no_match_evidence`としてreportし、改変や根拠のないresolved化を`failed`にする。
- event順序を`UNIQUE (fixture_revision_id, event_order)`でDB制約化した。
- 旧timeline indexを削除し、schema query plan testをrepositoryの`ORDER BY event_order`へ合わせた。
- expectationsの`unexpected`方向にも回帰testを追加した。

R4レビューは`CHANGES_REQUIRED`（BLOCKER 0 / MAJOR 1 / MINOR 2）。`ad2758d`で次を反映した。

- `clubCompetitionStats`と`_aggregateBaselines`をlegacy season aggregateへ欠落なく保存する。
- recordなしplayerのreadiness期待値をimporter helperから切り離し、固定snapshotから独立に構築する。
- match evidenceなしでCore team / competition IDを推測せず、対象product seasonはlegacy `season` row 1件のみを期待し、余剰scopeを`legacy_aggregate_scope_set_mismatch`で拒否する。
- identity gateの未保存player、根拠のないresolved化、tracking state drift、aggregate scope driftに回帰testを追加する。

R5レビューは`PASS`（BLOCKER 0 / MAJOR 0 / MINOR 2）で、Phase 3実装着手が許可された。Production cutoverは引き続き不可。`44a94cd`でMINOR 2件と観察事項を次のとおり反映した。

- aggregateのverification / bootstrap metadata 9 fieldをlegacy season payloadへ追加し、readiness側の独立期待値にも追加した。
- 実データ64 player×9 fieldの576比較で完全一致を確認した。
- identity-only playerのaggregate row集合をproduct season跨ぎで検査し、別season行も`legacy_aggregate_scope_set_mismatch`で拒否する。
- locale未指定`localeCompare()`をcode-point比較に置き換え、identity testを`jfwPlayerId`参照に変更した。

## 5. 検証証跡

- `node --test tests/*.test.js`: **257 tests / 255 pass / 0 fail / 2 todo / exit 0**
- 既知TODO: backfill idempotency 2件
- `git diff --check`: pass

## 6. 未充足の切替証跡

R5はPhase 2実装をPASSとし、Phase 3実装着手を許可した。残ったMINOR 2件は`44a94cd`で修正し、aggregate verification metadataの64 player×9 field（576比較）が完全一致すること、別product season行の注入でidentity gateが閉じることを確認した。

全回帰は`257 tests / 255 pass / 0 fail / 2 todo / exit 0`。ただしリポジトリには、期待scope全件の完全な2.1 canonical JSON/R2 bundle、Git補正定義、fixture catalog、適用済みローカルD1 database、reconciled parity coverage、readiness plan v2が保存されていない。そのため、現時点で実データ期待scopeの`phase2TechnicalGatePassed: true`は確認していない。

これはコードレビューを妨げないが、Phase 3 cutoverの承認条件を満たさない。実データ成果物が揃った後に、次を実行し、reportをこのパケットへ添付する必要がある。

```bash
node scripts/d1/verify-phase2-readiness.js \
  --snapshot /path/to/fixed-snapshot.json \
  --coverage /path/to/fixture-coverage-parity.json \
  --database /path/to/local-d1.sqlite3 \
  --plan /path/to/readiness/plan.json \
  --report /path/to/d1-phase2-readiness-report.json
```

## 7. Phase 3への引き継ぎ

R5の`Phase 3 implementation may start: YES`に基づき、次の制約付きで実装に進む。

- feature flagは既定OFFとする。
- endpoint単位でD1 / R2を切り替え、即時rollback可能にする。
- D1 read失敗時は検証済みR2 degraded fallbackへ移行し、失敗を観測可能にする。
- 実データ統合report、cutover前failure injection、形式レビューが揃うまでproduction cutoverは行わない。
