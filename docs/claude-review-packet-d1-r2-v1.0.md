# Claude レビューパケット: D1 / R2・ER・画面遷移 v1.1

状態: **Initial review received — changes prepared for re-review**
レビュー対象日: 2026-08-26
実装 gate: **BLOCKER / MAJOR が 0 になるまで実装しない**

## Claude への依頼

以下の2文書を設計レビューしてください。今回はレビューだけを行い、コード実装はしないでください。

1. `docs/data-storage-d1-r2-design-v1.0.md`
2. `docs/screen-flow-v2-d1-v1.0.md`

照合対象の既存仕様は次のとおりです。

- `docs/data-app-v2-direction.md`
- `docs/data-contract-v2.md`
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

### 7. 移行と rollback

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
| 未レビュー | — | — | — | Pending |

Claude の初回レビュー後、この表へ全 finding を登録する。BLOCKER/MAJOR を修正し、同じ review packet で再レビューを依頼する。`Verdict: PASS` かつ unresolved BLOCKER/MAJOR が 0 になった時点だけ、実装 Phase 1 へ進む。
