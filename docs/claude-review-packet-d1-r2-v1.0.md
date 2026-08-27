# Claude レビューパケット: D1 / R2・ER・画面遷移・Attention v1.2

状態: **Ready for Claude re-review**
レビュー対象日: 2026-08-27
実装 gate: **BLOCKER / MAJOR が 0 になるまで実装しない**

## Claude への依頼

以下の6文書を設計レビューしてください。今回はレビューだけを行い、コード実装はしないでください。

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
- R2 は raw、監査 snapshot、古い詳細 archive。
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
- 現行 143 tests / 141 pass / 0 fail / 2 todo の契約を守れるか。
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
| D1-023 | MAJOR | player recordをfixture scope化し、LIVE cap・内訳別60,000 writesモデル・runtime保護を定義 | `8c38816` | Pending |
| D1-024 | MAJOR | score partsをfixture scope化し、superseded cleanup対象をテーブル名で限定 | `8c38816` | Pending |
| D1-025 | MINOR | tracking periodのCore/legacy membership XOR制約と解決transactionを追加 | `8c38816` | Pending |
| D1-026 | MINOR | archive status、複数schema pointer、active切替とrollbackを追加 | `8c38816` | Pending |
| D1-027 | MINOR | contract 2.1.0、`detailAvailability` enum、2.0 upcaster、Phase 1更新境界を定義 | `8c38816` | Pending |
| D1-028 | MINOR | legacy hash 8種とplayer/club/season queryの実在写像へ差替え | `8c38816` | Pending |
| D1-029 | MINOR | `entity_field_states`を恒久表/index表へ追加しPK NOT NULLを明示 | `8c38816` | Pending |
| UI-001 | scope | 利用者貼付けAIだけを対象外とし、監視生成tracking insightsを承認済み機能として復帰 | `8c38816` | Pending |
| UI-002 | scope | 視聴済み移行を廃止し、決定的な視聴価値ランキングと完全なv1.0算式を追加 | `8c38816` | Pending |

第2回結果は `CHANGES_REQUIRED`、未解決BLOCKER 0件、MAJOR 2件（D1-023 / D1-024）、MINOR 5件（D1-025〜D1-029）。今回の正式レビューはこの7件とUI/Attentionの2件に絞る。`Verdict: PASS` かつ unresolved BLOCKER/MAJOR が0になった時点だけ実装 Phase 1へ進む。Attention用D1 3テーブルはそのgate通過後に設計追補し、別レビューを通す。
