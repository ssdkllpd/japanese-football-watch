# 正式レビューパケット: D1 / R2・ER・画面遷移・Attention v1.6

状態: **Codex formal review complete — PASS**
レビュー対象日: 2026-08-27
実装 gate: **BLOCKER / MAJOR が 0 になるまで実装しない**

## Codex正式レビュー結果

```text
Verdict: PASS
Implementation may start: YES
Unresolved BLOCKER count: 0
Unresolved MAJOR count: 0
Unresolved MINOR count: 0
Reviewer: Codex（ユーザー委任）
Reviewed at: 2026-08-27
```

### 今回の追加 findings

#### CR-001 — MAJOR — Resolved

- Location: `attention-score-v1.0.md` §6、`screen-flow-v2-d1-v1.0.md` §6/§7、`ui-wireframe-baseline-v1.0.md` §5
- Problem: `asOfUtc`だけを固定しても、page間にfinal publishや訂正が入ると候補集合が変わり、keyset cursorで重複・欠落が起きる。
- Required change: `candidateRevision`でimmutableな候補generationも固定し、cursorへscope/version/time/generation/sort tupleを束縛する。generation消失・TTL切れ・binding不一致は`409 attention_cursor_expired`で先頭から再取得する。
- Resolution: 3文書へ反映し、page間mutation・cursor失効の回帰条件を追加した。

#### CR-002 — MAJOR — Resolved

- Location: `data-contract-v2.md` §1/§11〜§16、`data-app-v2-direction.md` §10〜§12、`state/product_scope_v2.json.runtime`
- Problem: D1正本の承認対象と、旧「R2 canonical / demand-driven provider fetch」記述が並存し、承認後に二重の正本と公開provider fetchを実装できる状態だった。
- Required change: D1を構造化factsの正本、R2をraw/audit/LIVE projection/archive/degraded snapshotへ統一し、旧vertical sliceとR2 keyを移行前互換として明示する。
- Resolution: 所有権・LIVE経路・reconcile条件・既存2.0 artifactの位置付けを両文書で統一し、product scope runtimeをD1 target + 明示的な旧R2 rollbackへ更新した。現行`config/data-app-v2.json`は`mode: vertical_slice`の実装中rollback設定としてPhase 3切替まで維持する。

#### CR-003 — MINOR — Resolved

- Location: `attention-score-v1.0.md` §6
- Problem: 個人係数適用後に「同じ4段階規則」とだけあり、第1キーが中立scoreか個人scoreか曖昧だった。
- Required change: 個人一覧では第1キーだけを`personal_displayed_score`へ置換し、残る3キーを維持する。
- Resolution: 規則を明文化した。

### Confirmed strengths

- fixture detailの`staging -> published -> superseded`と公開pointerが分離され、staging appearance/player recordが公開queryへ漏れない。
- D1の日次上限モデルはindex増幅と旧snapshot cleanupを含む66,000 writes/日で、現行Free上限100,000 writes/日に対して保護modeを持つ。
- archiveはimmutable object、checksum、restore比較、active pointerのtransaction切替、D1削除の順でlosslessに設計されている。
- `0`、`NULL`、`not_fetched`、`provider_missing`、`not_applicable`、`conflict`が保存・DTO・画面で区別される。
- AttentionはCore/JFW factsだけから決定的に再現され、VAR/own goal/PK、decimal/JCS、follow候補復元、immutable cursor snapshotまで一意になった。
- hash route、5 destination、deep link、戻る/再読込、320px/44px/5tab、hot/archive/detail unavailableの画面契約が整合する。

### Gate decision

`Verdict: PASS`かつ未解決BLOCKER/MAJOR 0件のため、D1/R2移行のImplementation Phase 1を開始できる。Attention用D1 3テーブルは既定どおり先に設計追補を作成し、`candidateRevision`のimmutable generation/TTLを含む別レビューを通すまで実装しない。

## 正式レビュー依頼（履歴）

`design/d1-r2-er-screen-flow` の最新HEADにある以下の6文書を設計レビューしてください。今回はレビューだけを行い、コード実装・マージはしないでください。

1. `docs/data-storage-d1-r2-design-v1.0.md`
2. `docs/screen-flow-v2-d1-v1.0.md`
3. `docs/ui-wireframe-baseline-v1.0.md`
4. `docs/attention-score-v1.0.md`
5. `docs/data-contract-v2.md`（§4 Contract 2.1 detail availability）
6. `docs/data-app-v2-direction.md`

照合対象の既存仕様は次のとおりです。

- `docs/player-tracking-data-model-v1.0.md`
- `docs/api-football-schema-v2-mapping-v1.0.md`
- `state/product_scope_v2.json`
- `state/workflow_policy.json`
- `config/competition-scope-v1.json`

現行実装の境界確認には次も参照してください。

- `app-v2.js`
- `worker/index.mjs`
- `scripts/v2/fixture-contract.js`
- `tests/app-v2-shell.test.js`
- `tests/v2-fixture-contract.test.js`
- `tests/v2-date-feed.test.js`
- `tests/v2-standings.test.js`
- `tests/v2-worker.test.js`

## 確定済みの前提

次は好みの提案ではなく、今回のレビューで維持する決定です。重大な安全性・整合性問題がある場合だけ変更を提案してください。

- 構造化 facts の正本は D1。
- R2 は raw、監査 snapshot、古い詳細 archive、およびD1確定前の短期LIVE projection。恒久的な構造化factsの正本はD1のまま。
- D1 に保持する詳細は現行 + 直前2シーズン。
- hot に含まれない3シーズン前以前（N-3 以前）の詳細は、シーズン確定 + 90日後に archive。
- D1 350 MB を安全閾値として、必要なら古い確定シーズンを前倒し archive。
- compact fixture、最終スコア、entity、追跡 ID/所属、補正状態は D1 に恒久保持。
- 公開アクセスから API-Football を直接呼ばない。
- 公開 DTO の `af:*` ID、UTC/JST 規則、missing semantics は維持。
- 個人 follow のサーバー同期は認証設計まで延期。
- legacy の視聴済み状態と `jfw-watched-v1` はv2へ移行せず、決定的な視聴価値ランキングへ置き換える。個人の視聴状態は認証・同期設計後に再検討する。
- `attention_scores` と `tracking_insights` は `state/product_scope_v2.json` で承認済み。数値順位は決定的な式、`reason` / `insights` / `analysis` は `confidence` と出典を持つ別の注釈として分離する。
- 利用者が貼り付ける外部AI分析の保存・表示だけを今回の範囲外とし、route/API/DB/UIを作らない。
- Attention用のD1 3テーブル追加は今回のgate通過後の設計追補で行い、現在のERへ先回りして追加しない。

## 必須レビュー観点

### 1. ER とデータ所有権

- Core facts と Japanese tracking overlay の境界に重複や循環依存がないか。
- `INTEGER` 内部キーと公開 `canonical_id` の対応が移行・参照整合性に十分か。
- fixture、lineup、appearance、player stats の粒度が API-Football と既存 contract を損なわないか。
- `staging -> published -> superseded` lifecycle、`d1 / r2` detail location、公開 pointer で、chunk 書込み中の部分状態を確実に隠せるか。
- transfer、loan、out-of-scope、correction の履歴を失わないか。

### 2. missing / provenance / correction

- 明示的な 0、`NULL`、未取得、取得済み空、非該当を復元できるか。
- `section_states`、疎な `field_states`、`record_sources` の設計で監査可能か。
- Git の補正定義と D1 の照合状態の分担に矛盾がないか。
- provider 再取得時の `active / provider_caught_up / review_required` が保たれるか。

### 3. D1 query と容量

- 主要 endpoint に必要な index が揃っているか。
- EAV/JSON、多態参照、複合 PK が D1/SQLite で危険になっていないか。
- Free の50 queries/invocation、100 bound parameters/query、10 ms CPU を踏まえた chunk/publication 設計が成立するか。
- 500 MB 上限に対する 350 MB 閾値と3シーズン保持に見落としがないか。
- row-read / row-write が閲覧数・同期頻度に対して不必要に増えないか。

### 4. R2 archive

- export、checksum、pointer 登録、D1 detail 削除の順序が lossless か。
- 部分失敗、再実行、restore、schema version 移行が十分か。
- archive fixture が現行 endpoint/DTO から透過的に読めるか。
- raw snapshot の保持/削除規則が監査と容量の両面で妥当か。

### 5. 同期・安全性・quota

- 公開アクセスが API-Football quota を消費しない構成になっているか。
- scheduled ingest の部分更新、重複、順序逆転への対策が十分か。
- API key、D1、R2 のアクセス境界に漏れがないか。
- Origin 制限と rate limit をセキュリティ境界として過信していないか。
- 閲覧が Workers/D1/R2 の無料枠を消費する事実と、API-Football quota を消費しない事実が正しく分離されているか。

### 6. 画面遷移

- 5 destination と detail 画面の親子関係が自然か。
- hash route、戻る/進む、deep link、一覧 state 復元に矛盾がないか。
- 共通検索を6番目の主 destination にせず扱う設計が自然か。
- hot/archive、loading/empty/missing/error の違いが画面へ正しく反映されるか。
- Phase 1 parity と Phase 2 新機能の境界が現実的か。
- wireframe の generic `JP` と海外 Japanese tracking/JFW が混同されず、J1除外規則を守れているか。
- 視聴価値ランキングと JFW Rating 要因分解が不足なく配置され、未算出を0へ変換していないか。
- `reason` / `insights` / `analysis` が数値順位の入力へ混入せず、利用者貼付け分析だけが対象外として切り分けられているか。
- 320 px、文字サイズ、tap target、5 tab の操作性が実装可能か。

### 7. Attention Score

- base scoreが既存のCore/JFW factsだけから決定的に再現できるか。
- Rating、G/A、appearance、events、score partsの欠測・競合を0としていないか。
- 7日半減期、閾値、follow係数、同点規則が実装可能な純関数として一意か。
- 半減期の根拠が現行 `watch` の弱いラベルから配信可否を断定せず、将来の期限入力へ安全に移行できるか。
- annotationの`confidence`と弱い引用をfact provenanceへ混入させていないか。

### 8. 移行と rollback

- JSON -> D1 import、shadow read、endpoint 単位切替でデータ欠落を検出できるか。
- 現行HEADの実測 `148 tests / 146 pass / 0 fail / 2 todo` の契約を守れるか。
- 切替失敗時に旧 read path へ戻せるか。
- legacy JSON の停止条件が早すぎないか。

## 期待する回答形式

```markdown
Verdict: PASS | CHANGES_REQUIRED

## Findings

### D1-001 — BLOCKER | MAJOR | MINOR
- Location: 文書名 / 見出し
- Problem: 何が矛盾・欠落しているか
- Consequence: 実装すると何が壊れるか
- Required change: 具体的な修正文
- Evidence: 既存仕様・コード・D1/R2制約との対応

## Confirmed strengths
- 問題がないと確認できた重要点

## Gate decision
- Implementation may start: YES | NO
- Unresolved BLOCKER count: n
- Unresolved MAJOR count: n
```

抽象的な「将来検討」だけで終わらせず、BLOCKER/MAJOR には文書へ直接反映できる修正案を付けてください。設計範囲外の新機能は blocker にしないでください。

## レビュー反映台帳

| Finding | Severity | 対応 | 反映 commit | 再レビュー |
|---|---|---|---|---|
| D1-001〜D1-004 | BLOCKER | 初回指摘を設計 v1.1へ反映 | `3cfbd72` | Resolved 4/4 |
| D1-005 | MAJOR | compact score保持を追加。残るrevision scope問題はD1-024へ | `3cfbd72` | Partially resolved → D1-024 |
| D1-006 | MAJOR | Hot=N/N-1/N-2、Archive=N-3以前へ統一 | `3cfbd72` | Resolved |
| D1-007 | MAJOR | lifecycleを追加。残るrow-write問題はD1-023へ | `3cfbd72` | Partially resolved → D1-023 |
| D1-008〜D1-017 | MAJOR | 初回指摘を設計 v1.1へ反映 | `3cfbd72` | Resolved 10/10 |
| D1-018〜D1-020 | MINOR | 初回指摘を設計 v1.1へ反映 | `3cfbd72` | Resolved 3/3（D1-020付随はD1-026） |
| D1-021 | MINOR | URL互換規則を追加。実在集合の誤りはD1-028へ | `3cfbd72` | Partially resolved → D1-028 |
| D1-022 | MINOR | membership/trackingの無期限sentinelを統一 | `3cfbd72` | Resolved |
| D1-023 | MAJOR | 完全snapshotとrow-write予算を再設計 | `ad1d4ca` | Codex re-review: Resolved |
| D1-024 | MAJOR | score partsをfixture scope化し、superseded cleanup対象を限定 | `8c38816` | Independent review: Resolved |
| D1-025 | MINOR | tracking periodのCore/legacy membership XOR制約と解決transactionを追加 | `8c38816` | Independent review: Resolved |
| D1-026 | MINOR | archive status、複数schema pointer、active切替とrollbackを追加 | `8c38816` | Independent review: Resolved |
| D1-027 | MINOR | contract 2.1.0、`detailAvailability` enum、2.0 upcaster、Phase 1更新境界を定義 | `8c38816` | Independent review: Resolved |
| D1-028 | MINOR | legacy hash 8種とplayer/club/season queryの実在写像へ差替え | `8c38816` | Independent review: Resolved |
| D1-029 | MINOR | `entity_field_states`を恒久表/index表へ追加しPK NOT NULLを明示 | `8c38816` | Independent review: Resolved |
| D1-030 | MAJOR | revision scopeのappearanceを追加し、staging FKと公開境界を分離 | `ad1d4ca` | Codex re-review: Resolved |
| D1-031 | MINOR | player recordを`UNIQUE(fixture_id, player_id)`へ変更 | `ad1d4ca` | Codex re-review: Resolved |
| UI-001 | scope | 利用者貼付けAIだけを対象外とし、監視生成tracking insightsを承認済み機能として復帰 | `8c38816` | Independent review: Resolved |
| UI-002 | scope | 視聴済み移行を廃止し、決定的な視聴価値ランキングと完全なv1.0算式を追加 | `8c38816` | Independent review: Resolved |
| UI-003 | MAJOR | Worker候補下限16.00、候補DTO、follow involvementを固定 | `ad1d4ca` | Codex re-review: Resolved |
| UI-004 | MAJOR | goal/VAR/own-goal再生規則とFT/AET/PEN truth tableを追加 | `ad1d4ca` | Codex re-review: Resolved |
| UI-005 | MAJOR | canonical competition allowlistとscopeVersionをGit管理 | `ad1d4ca` | Codex re-review: Resolved |
| UI-006 | MINOR | decimal ROUND_HALF_UPとRFC 8785/JCS hashを固定 | `ad1d4ca` | Codex re-review: Resolved |
| UI-007 | MINOR | routeなし/有効/不正の3分岐へ遷移図を修正 | `ad1d4ca` | Codex re-review: Resolved |
| UI-008 | MINOR | legacy annotationの人手確認済みmetadata移行を縮退条件化 | `ad1d4ca` | Codex re-review: Resolved |
| PFR-001 | MAJOR | Attentionの全cursor pageで`asOfUtc`を固定し、全候補取得後だけ個人順位を確定 | `55b8236` | Codex re-review: Resolved（CR-001で強化） |
| PFR-002 | MINOR | precision 34 decimalをcanonical string化してからJCSへ渡す規則を追加 | `55b8236` | Codex re-review: Resolved |
| PFR-003 | MINOR | comeback state machine、VAR取消再計算、score parts値整合を固定 | `55b8236` | Codex re-review: Resolved |
| PFR-004 | MINOR | 未公開player recordの訂正・不変化・orphan cleanup境界を追加 | `55b8236` | Codex re-review: Resolved |
| CR-001 | MAJOR | Attention cursorへimmutable `candidateRevision`と失効契約を追加 | `03412a8` | Codex re-review: Resolved |
| CR-002 | MAJOR | D1/R2所有権とscheduled LIVE経路を旧文書まで統一 | `bbb3411` | Codex re-review: Resolved |
| CR-003 | MINOR | 個人順位の第1sort keyを`personal_displayed_score`へ固定 | `9a3c46b` | Codex re-review: Resolved |

独立レビュー第1回は `CHANGES_REQUIRED`、未解決BLOCKER 0件、MAJOR 5件、MINOR 4件だった。事前再レビューでD1-023、D1-030〜031、UI-003〜008の9件とPFR-001〜004を解消した。ユーザー委任によるCodex正式レビューでは全履歴と修正回帰を再確認し、追加CR-001〜003も同じreview cycleで解消した。統合判定は`PASS`、unresolved BLOCKER/MAJOR/MINORはいずれも0件。Attention用D1 3テーブルはgate通過後の設計追補と別レビューを必要とする。
