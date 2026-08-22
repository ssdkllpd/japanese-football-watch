# JFW Rating v1.0 — データ運用ルール（ops-v1.0）

計算式仕様とは別管理。計算式 `v1.x` と取得運用 `ops-v1.x` は独立して版を持つ。

## 1. 出典管理

出典は試合単位で `ratingSources` に正規化し、各入力項目は `sourceId` のみを持つ。

```json
{
  "ratingSources": [
    {
      "id": "s1",
      "name": "リーグ公式マッチセンター",
      "type": "league_official_events",
      "url": "https://...",
      "retrievedAt": "2026-08-20T08:04:00+09:00",
      "priority": 1,
      "exhaustiveFor": ["minutes", "goals", "assists"]
    }
  ],
  "ratingInputs": {
    "goals": { "state": "value", "value": 1, "sourceId": "s1" },
    "shots": { "state": "missing" }
  }
}
```

`missing` に `sourceId` は付けない。

### sourceId の一意性と訂正

- `sourceId` は、同じbackfill manifest全体で同一の情報源を指す識別子として扱う。
- 後続フラグメントで同じIDを再定義できるのは、URLや取得情報など同一情報源の訂正時だけとする。別の情報源には新しいIDを付ける。
- merge coreはmanifest順の後勝ちでsource定義を解決し、その定義を同じIDを参照する全レコードへ遡及適用する。
- `exhaustiveFor` の縮小はmissingと0の判定を変えるため、通常の訂正に混ぜず、差分テストで明示してレビューする。

### 競合解決

同じ項目で情報源が競合した場合は、事前固定した `priority` の小さい情報源を採用する。数値を見て都合のよい方を選ばない。
破棄値は `ratingConflicts` に残して監査可能にする。

### 事後修正

試合終了から72時間は再取得し、公式修正などで入力が変わればRatingを再計算する。修正時は `revisedAt` と `previousRating` を残す。72時間経過後は原則固定し、手動操作時のみ更新する。

## 2. 0を確定できる条件

情報源がその項目を網羅していると事前定義されている場合のみ、「記録がない」ことから `value: 0` を導出できる。
それ以外の言及なし・空欄は `missing`。

例:

- 公式イベントログがゴールを網羅しており選手の記録なし → `goals: value 0`
- 記事が「先発」とのみ記載 → `goals: missing`
- 統計ページのシュート欄が `0` → `shots: value 0`
- 統計ページにシュート列自体がない → `shots: missing`

「言及なし」と「0」は同一視しない。

## 3. ratingPosition

優先順位:

1. その試合の公式フォーメーション・スタメン表記 (`match_official`)
2. 準公式/統計サイトの試合ポジション (`match_secondary`)
3. シーズン固定 `primaryRatingPosition` (`season_primary`)
4. 不明なら `unknown` としRatingを算出しない

評価バケット:

- GK → GK
- CB/LCB/RCB/LB/RB/LWB/RWB → DF
- DM/CDM/CM/AM/CAM/LM/RM → MF
- LW/RW/SS/CF/ST → FW

試合中にポジション変更した場合は原則先発位置。出場時間の過半を別ポジションで過ごしたことを確認できる場合のみ変更する。
`ratingPosition` は計算前に確定し、計算後にスコア都合で変更しない。

## 4. 同一分の失点と交代

秒単位またはイベント順が取得できればそれに従う。
取得できず、失点とDF/GKの交代が同じ分の場合は **失点→交代** の順とみなし、その失点を `GA_onpitch` に含める。

```json
"gaOnPitchAmbiguous": true
```

を付けて監査可能にし、より細かい時系列を後から取得できたら再計算する。
このルールは曖昧時に選手に有利な側へ倒さないための明示的な例外であり、通常の欠損補完には拡張しない。

## 5. 直近N試合

「直近5出場」を窓にする。出場は `minutes > 0`。
ベンチ未出場・ベンチ外は窓に含めない。
窓内でRating算出不能の試合は平均の分母から除外するが、窓を過去へ延長しない。

表示例:

```text
直近5出場平均 7.32 （3/5試合で算出）
対象試合       5 / 7 （Rating算出 / 出場）
```

## 6. 率系入力の保存単位

比率は0〜1の実数として扱う。可能な場合は比率そのものだけでなく分子・分母の生値を保存する。

- `duelsWon / duelsTotal`
- `aerialDuelsWon / aerialDuelsTotal`
- `passesCompleted / passesAttempted`
- `saves / shotsOnTargetFaced`

エンジンが比率を導出する場合も元のカウント値を保持する。

## 7. v1.0固定値

実測が50〜100試合に達するまで以下を固定する。

- 基準点 6.00
- `K_cov` 定数 0.30
- `K_min` 定数 20、90分クランプ
- Ratingクランプ 3.00〜10.00
- 信頼度境界 0.75 / 0.40
- 最低条件 `minutes / goals / assists`
- 再取得窓 72時間

実測後に変更する場合は `v1.1` / `ops-v1.1` として明示し、必要な過去データを再計算する。
