# Player Tracking Data Model v1.0

## 目的

海外日本人追跡アプリで、試合単位の事実、シーズン通算、各大会、各所属クラブの成績を混同せず、シーズン途中の移籍後も同一選手として継続追跡する。

この文書では `playerMatchStats` を試合事実の正本とし、派生集計はいつでも再構築できることを必須とする。

## 1. 選手ID

- 選手はクラブやリーグではなく、シーズンを通じて不変の `playerId` で識別する。
- 移籍しても新しい選手レコードを作らない。
- 既存データに `playerId` がない場合は移行用に安定IDを生成する。
- 名前一致は旧データ移行のフォールバックに限定し、新規更新では `playerId` を優先する。

## 2. 試合事実の正本

各 `playerMatchStats` は最低限、可能な限り以下を保持する。

- `recordId`
- `playerId`
- `matchId`
- `playerName`
- `club`: その試合時点の所属クラブ
- `competition`: その試合の大会
- `match`
- `ko`
- `round`
- `trackedAtMatch`
- `ratingInputs` と各 sourceId
- 取得済み生値、missing/notApplicable 状態

得点・アシスト等の派生集計から試合を逆算するのではなく、`playerId -> playerMatchStats -> matchId -> matches` で「どの大会・どの試合で記録したか」を常に辿れること。

## 3. シーズン集計は4層で保持する

二者択一で「シーズン合計だけ」または「クラブ別だけ」にしない。

### `seasonStats`

当該シーズンに追跡対象として取得した公式戦の合計。個人成績ランキングの「すべて」の正本。

### `competitionStats`

大会別集計。

例:

```json
{
  "Premier League": {"goals": 2},
  "UEFA Europa League": {"goals": 1}
}
```

大会別ランキングはこの値を使う。現在どのリーグに所属しているかで過去大会成績を付け替えない。

### `clubStats`

当該シーズンの所属クラブ別集計。

例:

```json
{
  "Club A": {"goals": 2},
  "Club B": {"goals": 1}
}
```

クラブ画面では必ずこの値を使う。`seasonStats` を現在所属クラブへそのまま表示しない。

### `clubCompetitionStats`

クラブ×大会別集計。移籍元・移籍先が同じ大会に所属する場合でも成績を分離できるようにする。

### legacy aggregateの検証metadata

recordから再構築できない移行中の集計は、4層の値に加えて次のmetadataを保持する。

- `statsScope`、`statsStatus`、`statsAsOf`、`statsTrackingState`
- `_initialStats`、`_initialClub`、`_initialLeague`
- `_initialStatsCaptured`、`_initialStatsUpdated`
- `_aggregateBaselines`

これらは未検証集計を検証済みと区別し、後続のCore再集計でbaselineの出所を証明するための移行事実である。表示用の`status`、`rank`、`priorityFields`等はaggregate contractに含めず、固定snapshotとR2 raw artifactに保持する。

## 4. missing の扱い

- 不明値を0へ変換しない。
- 集計を構成する試合または確定集計に未取得が含まれる項目は、その集計項目も原則 `null` とする。
- 0は当該項目を網羅する情報源から明示的に確認された場合のみ確定する。
- 得点だけ確定してアシストが未取得の場合、得点は集計へ反映し、アシストは `null` のまま保持する。

## 5. 所属履歴

選手は `membershipHistory` を持つ。

```json
[
  {
    "club": "Club A",
    "league": "Premier League",
    "from": "2026-07-01",
    "to": "2027-01-15",
    "tracked": true,
    "changeType": "initial"
  },
  {
    "club": "Club B",
    "league": "Bundesliga",
    "from": "2027-01-15",
    "to": null,
    "tracked": true,
    "changeType": "transfer"
  }
]
```

移籍・期限付き移籍・復帰は新しい所属期間を追加する。単なる過去データの訂正は新しい所属期間を作らず `membershipCorrections` に残す。

## 6. 所属変更イベント

確定した所属変更を更新するときは可能な限り以下を明示する。

- `membershipChangeType`: `transfer`, `loan`, `loan_return`, `registration`, `correction`
- `effectiveDate` または `transferDate`
- 新所属 `club`, `league`
- `previousClub`, `previousLeague`
- `sourceIds`

本物の移籍と過去データ訂正を同じ「club上書き」で処理しない。

## 7. 追跡対象リーグ内への移籍

追跡対象から追跡対象へ移籍した場合:

1. `playerId` を維持する。
2. 旧所属期間を終了し、新所属期間を追加する。
3. `previousClub` / `previousLeague` を保持する。
4. 新クラブの試合取得を通常対象として継続する。
5. `seasonStats` はシーズン通算として継続する。
6. `clubStats` は旧クラブと新クラブを分離する。
7. `competitionStats` は大会別に継続する。
8. JFW Rating の直近5出場・シーズン平均は同一選手の当該シーズン記録として継続する。ただし異なるRating versionは混在させない。

## 8. 追跡対象外リーグへの移籍

J1、MLSその他このアプリが試合追跡していないリーグへ移籍した場合:

- 選手レコードは削除しない。
- 実際の移籍先 `club` と `league` を保存する。
- `previousClub` / `previousLeague` と `membershipHistory` を保存する。
- `trackingStatus = "out_of_scope"` とする。
- UI上は `無所属・追跡対象外` 枠へ分類する。
- `rankingEligible = true` を維持し、移籍時点までに取得済みの `seasonStats` を個人成績ランキングへ残す。
- 移籍先クラブを「追跡クラブ一覧」へ追加しない。
- 追跡対象外移籍後の試合データを通常更新では取得・自動加算しない。
- 追跡済み成績は `statsTrackingState = "frozen_out_of_scope"` として保持する。

この「無所属・追跡対象外」は所属不明を意味しない。実際の移籍先クラブ/リーグは選手プロフィールに表示する。

## 9. 追跡対象への復帰

追跡対象外から追跡対象リーグへ移籍・復帰した場合:

- 同じ `playerId` を再利用する。
- 新しい tracked=true の所属期間を追加する。
- `trackingStatus = "active"` に戻す。
- その時点から試合追跡と個人データ取得を再開する。
- 同一シーズンなら、過去の追跡済み `seasonStats` に新たな追跡対象期間の成績を加算する。

## 10. 表示方針

選手画面の主表示は「今シーズン通算」とする。理由は、移籍しても選手自身のシーズンの流れを一つの画面で確認でき、ランキングとの意味も一致するため。

その下に必ず以下を表示できる構造にする。

1. 大会別成績
2. 所属履歴・クラブ別成績
3. 直近試合（クラブ、大会、試合、日時付き）

クラブ画面ではそのクラブ在籍時の `clubStats[club]` だけを表示する。

## 11. ランキング

- 「すべて」: `seasonStats`
- 大会別: `competitionStats[competition]`
- 移籍後も当該シーズンの取得済み成績を保持する。
- 追跡対象外へ移籍した選手も `rankingEligible=true` なら「すべて」および過去に出場した大会別ランキングに残す。
- 現在所属リーグを条件にして、過去大会の成績を現在所属リーグへ再分類してはならない。
- JFW Ratingのポジション横断ランキングは作らない。

## 12. クラブ画面

- 現在そのクラブに所属し、追跡対象リーグにいる選手だけを現在所属人数へ数える。
- クラブの日本人G/A集計には `clubStats[club]` を使う。
- 選手名だけを条件に過去・他クラブの試合をクラブ画面へ混入させない。
- 試合は `playerMatchStats.club` / `matchId` または試合そのもののクラブ名で紐付ける。

## 13. データ更新時の必須整合性チェック

選手・試合・所属変更のいずれかを更新したら、以下を確認する。

- 同一 `playerId` が複数の現在所属レコードへ分裂していない。
- `membershipHistory` に同時期の重複所属が不当に存在しない。
- 全 `playerMatchStats` が可能な限り `playerId`, `matchId`, `club`, `competition` を持つ。
- `seasonStats` と clubStats/competitionStats の元データが同じ `playerMatchStats` へ辿れる。
- 旧クラブの成績が新クラブの `clubStats` に混入していない。
- 大会別ランキングが現在所属リーグで再分類されていない。
- 追跡対象外移籍選手が players / seasonStats / ranking から消えていない。
- 追跡対象外の移籍先クラブが追跡クラブ一覧に混入していない。
- correction が transfer として所属履歴を増やしていない。
- missing が0へ変換されていない。

## 14. 新規選手追加

新規選手も最初からこのモデルを使う。

- `playerId` を付与。
- 現所属を `membershipHistory` の初期期間として登録。
- `trackingStatus` を設定。
- 試合データには `playerId`, `matchId`, `club`, `competition` を保存。
- 集計値を手入力する場合も `aggregateAsOf` / `statsAsOfDate` を付け、どこまでの試合を含む確定値かを機械判定できるようにする。

派生値だけを追加し、試合との紐付けを失う更新は禁止する。
