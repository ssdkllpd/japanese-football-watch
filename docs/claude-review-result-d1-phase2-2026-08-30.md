# D1 Phase 2 Claude formal review result — 2026-08-30

対象実装HEAD: `3f9fe90ffa5ccad8c21b478180619114c7702c61`

反映commit: `0e74f2c0e479b0fb7720c4d51f614d6b900027de`

## Verdict

```text
Verdict: CHANGES_REQUIRED
BLOCKER: 2
MAJOR: 3
MINOR: 4

Phase 3 implementation may start: NO
Production cutover may start: NO
```

## Findingsと反映

| Severity | Finding | 反映 |
|---|---|---|
| BLOCKER | Rating gateがsnapshot全120 recordを分母にし、`ratingVersion`を持たない未採点65 recordで永久に閉じる | readiness plan v2の`ratingRecordIds`を期待分母とし、未採点かつRating未宣言を`not_applicable`へ分離。期待集合へ宣言された未採点recordは`expected_rating_not_authored`でfail closed |
| BLOCKER | Crosswalk gateが全64 playerを分母にし、provider identity未確定37 playerとrecordなしplayerで永久に閉じる | `trackedPlayerIds`を期待分母として必須宣言し、集合外を`not_applicable`へ分離。集合内の証拠不足は従来どおり`deferred` |
| MAJOR | semantic shadowが全arrayをsortし、event時系列とlineup entry順の破損を見逃す | `events`、`lineups[].startXI`、`lineups[].substitutes`をordered arrayとして保持。`fixture_lineup_entries.entry_order`を追加し、reportに`comparisonCoverage`を記録 |
| MAJOR | D1 DTOの補正reason/sourceUrl/verifiedAtを比較対象JSONから注入して差分検出不能 | JSONからの注入を削除。独立したGit定義file、JSON/R2 bundle、D1保存snapshotの三者照合へ変更 |
| MAJOR | 1 player / 1 recordの全充足testだけで混在snapshotを検証していない | 未採点record、provider identity未確定player、out-of-scope playerを含む混在snapshot testを追加。scope外なら5 gate通過、期待集合へ追加すると該当gateが閉じることを確認 |
| MINOR | TODOを1件と誤記 | 実測どおり2件へ修正 |
| MINOR | packetの対象HEAD／branch HEAD記述が不一致 | 実装対象HEADとpacket更新commitを分離して記録 |
| MINOR | tracking statusが自由文字列 | `tracked_players`と`tracking_periods`へ許可値CHECKを追加 |
| MINOR | link+parityを3回全走査 | readiness evaluatorで1回だけ再計算し、Rating／aggregate verifierへ同じ結果を渡す |

全findingの反映commitは `0e74f2c0e479b0fb7720c4d51f614d6b900027de`。

## 再検証

- 実データsnapshot分類: 120 records、Rating期待候補55、未採点65、players 64、provider identity未確定37、recordなし9
- Claude finding関連tests: **59 pass / 0 fail**
- 全回帰: **246 tests / 244 pass / 0 fail / 2 todo**
- `git diff --check`: pass
- 既知TODOはbackfill idempotency 2件で、今回のPhase 2変更による新規failureではない

## 再レビュー条件

Claudeは`3f9fe90..0e74f2c`をdiff-focusedで再レビューする。コード修正がPASSしても、実データ用canonical bundle、D1、coverage、readiness plan v2による統合reportが未添付の間はProduction cutoverを許可しない。
