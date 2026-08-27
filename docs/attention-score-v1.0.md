# Attention Score v1.0 — 視聴価値ランキング仕様

状態: **Proposed — Claude正式レビューPASSまで実装禁止**
対象: configured overseas leagues の追跡対象選手が関与した完了試合
作成日: 2026-08-27
関連文書: `jfw-rating-v1.0.md`、`ui-wireframe-baseline-v1.0.md`、`screen-flow-v2-d1-v1.0.md`、`state/workflow_policy.json`、`config/competition-scope-v1.json`

## 1. 目的と非目的

Attention Score は「今から見返す価値が高い試合」を、同一入力と同一基準時刻から決定的に並べるための指標である。LLM の判断や生成文を順位計算へ入れない。

この仕様が扱うもの:

- 時刻非依存の `base_score`
- read 時だけ適用する時間減衰
- 表示閾値、同点時の順序、版管理
- 欠測・競合・非該当の扱い

この仕様が扱わないもの:

- `reason` / `insights` / `analysis` の文章生成
- 個人の視聴済み状態
- 大会の主観的な格付け
- LLM による順位補正

説明文は数値とは別の tracking annotation であり、`confidence` と出典を付けて表示する。説明文の有無や内容は Attention Score を変えない。

## 2. 対象と入力

v1.0 の対象は、次をすべて満たす fixture とする。

1. status が `FT` / `AET` / `PEN` のいずれか。
2. fixture 時点で有効な `tracking_periods` を持つ選手が1人以上 `started` または `substitute_used`。
3. fixture の competition canonical ID が `config/competition-scope-v1.json.attentionEligibleCompetitions` に含まれ、`competitions.type` が `League` または `Cup`。allowlist外、friendly、preseasonは `not_applicable`。

| 入力 | 正本 | 必須性 |
|---|---|---|
| 追跡選手の JFW Rating | `jfw_rating_results.rating` と `rating_state` | 出場した追跡選手全員で必須 |
| 直接 G/A 関与 | `jfw_rating_results.inputs_json` 内の確認済み goals / assists。`fixture_events` と不一致なら競合 | 必須 |
| 出場状況 | 公開revisionの `fixture_player_appearances.appearance_state`、`minutes` | 必須 |
| 最終スコアと試合状態 | `fixtures.home_goals` / `away_goals`、`status_short` | 必須 |
| 競り合い度 | `fixture_events`、`fixture_score_parts` | 必須 |
| 大会種別 | `competitions.type` | 必須 |
| 関与した追跡選手数 | `tracking_periods` × 公開revisionの `fixture_player_appearances` | 必須 |

Core の同じ facts を tracking 側へ複製しない。計算時に `fixtures.published_revision` と一致するappearanceだけをfixture scopeのplayer recordへ結合し、staging/superseded appearanceを除外する。`inputs_json` には使用値・presence・canonical IDに加え、`scopeVersion`、competition canonical ID、公開revisionのcontent hashを保存する。

### 2.1 大会scopeの正本

大会選択の正本はGit管理の `config/competition-scope-v1.json` とする。名称配列、localized label、ブラウザfollowから対象を推測しない。

- `scopeVersion = "1.0"`
- `trackingLeagues` は海外追跡リーグのcanonical ID集合。
- `attentionEligibleCompetitions` はAttention計算を許可するリーグ・カップのcanonical ID集合。
- J1、friendly、preseason、未知IDは包含規則ではなくallowlist不一致により対象外。
- ID追加・削除時は `scopeVersion` と `attention_version` を上げる。過去の `inputs_json` には当時のscope versionとcompetition IDを残す。

## 3. base score

```text
base_score = clamp(
  rating_component
  + direct_contribution_component
  + appearance_component
  + drama_component
  + tracked_players_component,
  0,
  100
)
```

全計算は丸め前の値で行い、最後だけ§4.1の規則で小数第2位へ丸める。

### 3.1 Rating component（0〜40）

出場した追跡選手の JFW Rating を降順に `r1, r2, ...` とする。

```text
primary = 30 × clamp((r1 - 6.00) / 4.00, 0, 1)
depth   = n >= 2
  ? 10 × clamp((mean(r2 ... rn) - 6.00) / 4.00, 0, 1)
  : 0
rating_component = primary + depth
```

最高評価者を中心にしつつ、同一試合で複数の追跡選手が好成績だった場合だけ最大10点を追加する。Rating 6.00未満を負点にはしない。

### 3.2 Direct contribution component（0〜25）

出場した追跡選手全員の確認済み得点数を `G`、アシスト数を `A` とする。

```text
direct_contribution_component = min(25, 10 × G + 7 × A)
```

JFW Rating 内にもG/Aは含まれるが、視聴対象として直接得点関与を強く示すため、ここでは意図的に別加点する。event と player stat が競合する場合は片方を採用せず、base score 全体を未算出とする。

### 3.3 Appearance component（0〜10）

```text
appearance_component = min(
  10,
  3 × started_count + 2 × substitute_used_count
)
```

`bench_unused`、`absent_confirmed` は0点ではなく非関与であり count に入れない。`appearance_state = unknown` の追跡選手がいる場合は未算出とする。

### 3.4 Drama component（0〜15）

```text
margin_bonus =
  goal_difference == 0 ? 6 :
  goal_difference == 1 ? 4 :
  goal_difference == 2 ? 2 : 0

comeback_bonus = 4  // 追跡選手所属チームが一度ビハインドから同点または勝利
extra_time_bonus = 2
penalty_bonus = 3

drama_component = min(
  15,
  margin_bonus + comeback_bonus + extra_time_bonus + penalty_bonus
)
```

`comeback_bonus` は公開revisionのeventが `presence: present` の場合だけ、次の決定的な再生規則で判定する。

1. `(elapsed, extra_minute NULLS FIRST, event_order)` の昇順で処理する。3値が同じeventは許可せず、重複時は`conflict`。
2. ingest時に `type = goal` を `normal_goal`、`penalty_scored`、`own_goal`、`missed_penalty`へ正規化する。前3種だけを1得点とし、`missed_penalty`は0得点。canonical `team_id` は常に得点を与えられるhome/away側とし、own goalの選手所属側ではない。どちらへ加点するか一意に正規化できなければ`conflict`。
3. `type = var` かつ正規化detailが `goal_cancelled` の場合、同じteam/playerに対する直前の未取消goal候補を取り消す。一意に対応できない、または先行goalがない場合は`conflict`。その他のVARはscoreを変更しない。
4. PK戦のkickは通常event再生へ含めず、`fixture_score_parts.penalty`だけで扱う。
5. 再生後のhome/away scoreがcompact最終scoreと一致しなければ`conflict`としてbase score全体を未算出にする。

`comeback_bonus` は、追跡選手が出場したteamについて、event再生中に一度でも相手より少ないscoreになり、その後の有効goal処理後に同点またはリードへ到達した場合に1回だけ4点とする。最終結果が再び敗戦でも、この条件を途中で満たしていれば加点する。両teamに追跡選手がいて双方が条件を満たしてもfixture全体で4点を上限とする。VAR取消後は取消対象goalが存在しなかった状態からscore列と条件判定を再計算し、取り消された同点・逆転を加点根拠に残さない。

score parts / events が未取得、競合、順序不明なら0にせず、base score全体を未算出にする。延長・PKの加点は次で固定する。

| `status_short` | extra-time state | penalty state | extra-time bonus | penalty bonus | 判定 |
|---|---|---|---:|---:|---|
| `FT` | `not_applicable` | `not_applicable` | 0 | 0 | 有効 |
| `AET` | `present` | `not_applicable` | 2 | 0 | 有効 |
| `PEN` | `present` | `present` | 2 | 3 | 延長後PK |
| `PEN` | `not_applicable` | `present` | 0 | 3 | 直接PK |
| その他の組合せ | 任意 | 任意 | — | — | `conflict`または`missing`で未算出 |

この表の`present`はhome/awayの両値が非NULLの非負整数であることを含む。`PEN`ではpenalty scoreが同点ではなく、PK戦を除いたcompact最終scoreは同点でなければならない。`AET` / 延長後`PEN`のextra-time scoreはcompact最終scoreと整合しなければならない。presenceだけが`present`でも値が欠ける、勝者が決まらない、またはscore間で矛盾する場合は`missing`または`conflict`として未算出にする。

### 3.5 Tracked players component（0〜10）

```text
tracked_players_component = min(10, 3 × tracked_players_used)
```

`tracked_players_used` は fixture 時点の tracking period が有効で、`started` または `substitute_used` の選手数とする。同一人物を event、lineup、stats の複数経路から重複計上しない。

### 3.6 Competition type

v1.0 はallowlist内の公式 `League` と `Cup` をどちらも係数 `1.00` とする。provider の2値や名称だけから大会の格・対象可否を推測しない。friendly / preseason はランキング対象外とする。将来、大会別係数を導入する場合は同じGit管理設定へ根拠付きで追加し、`scopeVersion` と `attention_version` を上げる。

### 3.7 計算例

追跡選手2人が先発し、Ratingが8.00と7.00、合計1G1A、1点差の通常時間決着、逆転なしの場合:

```text
rating_component             = 30 × (2/4) + 10 × (1/4) = 17.50
direct_contribution_component = 10 × 1 + 7 × 1       = 17.00
appearance_component          = 3 × 2                  = 6.00
drama_component               = 4.00
tracked_players_component     = 3 × 2                  = 6.00
base_score                    = 50.50
```

kickoffからちょうど7日後は `displayed_score = 25.25`、14日後は `12.63` となり、14日後は閾値20未満で一覧から外れる。

## 4. 欠測・競合・非該当

`state/workflow_policy.json` の `neverTreatMissingAggregateInputAsZero` をそのまま適用する。

- 出場した追跡選手の JFW Rating が1件でも `NULL` または `rating_state = missing` なら `base_score = NULL`、状態は `missing`。
- 対象 fixture に出場した追跡選手がいなければ `base_score = NULL`、状態は `not_applicable`。
- 必須入力が `not_fetched` / `provider_missing`、または source 間で競合していれば `base_score = NULL`、状態は `missing` または `conflict`。
- `0` は全必須入力を確認した結果として計算値が0の場合だけ保存できる。
- `NULL` の fixture はランキングから除外するが、fixture detail では「視聴価値は未算出」と表示し、「価値なし」「0点」と表示しない。

入力状態と採用 source は `inputs_json` に残し、`source_hash` は§4.1のcanonical JSONをUTF-8 encodingしたbyte列のSHA-256とする。

### 4.1 数値・canonical JSON

- 算式はprecision 34、`ROUND_HALF_UP`のdecimal arithmeticを使い、実装時に同じversionのdecimal libraryをWorkerとtestへ固定する。native binary floating-pointの`Math.round` / `Math.pow`をreference計算にしない。
- `round2(x)` は非負のdecimal値を小数第2位へ `ROUND_HALF_UP` し、常に2桁のdecimal stringとしてserializeする。例: `1.005 -> "1.01"`、`1 -> "1.00"`。
- canonical JSONはRFC 8785（JCS）に従い、UTF-8でencodeする。precision 34で計算したdecimalをJCSのJSON numberへ直接渡さない。hash入力では、decimal値を指数表記なし・末尾0除去・負の0禁止のcanonical decimal stringへ変換し、整数はJSON integer、`round2`の結果は常に2桁のstringとしてからJCSを適用する。例: `1.2300 -> "1.23"`、`0.000 -> "0"`、`-0 -> "0"`。
- hash対象は `attentionVersion`、`scopeVersion`、fixture/competition canonical ID、kickoff UTC、公開revision content hash、最終score/status/score parts、正規化event列、JFW player ID順のappearance/rating/G/A/presence/source、canonical decimal string化した丸め前component入力とする。
- `now_utc`、減衰後score、follow状態、annotation本文はhashへ含めない。

## 5. 時間減衰

D1/R2へ保存するのは時刻非依存の `base_score` だけである。表示値は公開 Worker の純関数としてread時に計算し、DBへ書き戻さない。

```text
age_hours = max(0, (now_utc - kickoff_utc) / 1 hour)
displayed_score = round2(base_score × 2 ^ (-age_hours / 168))
```

v1.0 の半減期は **168時間（7日）** とする。現行 `watch` は `DAZN`、`U-NEXT系`、`Celtic TV系`、`BS10`、`配信確認` のラベルだけで、試合ごとの配信終了日時を持たない。また公式案内でも、DAZNはコンテンツごとに期間が異なり詳細画面で確認する方式、U-NEXTも作品詳細ごとに終了日時を示す方式である。U-NEXTの公式事例には試合後およそ11〜14日の見逃し期間がある一方、Celtic Playerはfull-match replayへのアクセスを案内するものの一律の終了日時を示していない。統一期限を偽って hard cutoff にせず、1〜2週間で優先度を段階的に落とす保守値として7日を採用する。

根拠（2026-08-27確認）:

- [DAZN 配信コンテンツ・スケジュール](https://www.dazn.com/ja-JP/help/articles/16944644312861-%E9%85%8D%E4%BF%A1%E3%82%B3%E3%83%B3%E3%83%86%E3%83%B3%E3%83%84%E3%82%B9%E3%82%B1%E3%82%B8%E3%83%A5%E3%83%BC%E3%83%AB%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6)
- [U-NEXT サッカー日本代表強化試合の配信例](https://help.unext.jp/info-video/detail/info713b)
- [U-NEXT サッカーライブ配信FAQ](https://help.unext.jp/guide/detail/about-football-l)
- [Celtic Player](https://www.celticfc.com/celtic-player/)

将来 `watch.available_until` が authoritative source と確認時刻付きで取得できるようになった場合だけ、`min(decay, hard cutoff)` へ変更できる。これは算式変更なので版を上げる。

## 6. 表示閾値・並び順・個人重み

中立ランキングの表示閾値は `displayed_score >= 20.00` とする。個人係数の最大値が1.25なので、Workerは中立 `displayed_score >= 16.00`（`20.00 / 1.25`）のfixtureを候補として返す。16.00未満を返す必要はなく、16.00以上20.00未満はブラウザがfollow適用後に採否を決める。

並び順は次で固定する。

1. `displayed_score` 降順
2. `base_score` 降順
3. `kickoff_utc` 降順
4. fixture canonical ID 昇順

フォロー情報はサーバへ送らず、ブラウザ内で次の係数を中立な `displayed_score` へ掛ける。

```text
follow_multiplier = min(
  1.25,
  1.00
  + (followed player involved ? 0.15 : 0)
  + (followed club involved ? 0.10 : 0)
)

personal_displayed_score = round2(displayed_score × follow_multiplier)
```

`followed player involved` は、ローカルfollow中のplayer IDが公開revisionで `started` または `substitute_used` の場合だけ真とする。`followed club involved` は、ローカルfollow中のteam IDがfixtureのhome/away team IDと一致する場合だけ真とする。

Workerの候補DTOは少なくとも `fixtureId`、`baseScore`、中立`displayedScore`、`attentionVersion`、`scopeVersion`、関与したplayer ID配列、home/away team IDを返す。候補endpointは最初のresponseで固定した`asOfUtc`を全cursor pageで共有し、中立16.00以上の候補を欠落なく返す。各pageは`nextCursor`を持ち、ブラウザは`nextCursor = null`まで取得してからローカルfollow係数を適用する。途中pageだけで最終順位・件数を確定表示せず、全候補取得中であることを示す。同一`asOfUtc`を維持できないcursorは失効エラーにして最初から再取得する。

ブラウザは完全な候補集合へローカルfollowだけから係数を計算し、`personal_displayed_score >= 20.00`を残して同じ4段階規則で並べ直す。個人係数は表示順と表示閾値だけに使い、`base_score`、`source_hash`、サーバの中立順位を変更しない。`base_score <= 100`かつ半減期168時間なので、16.00以上の候補期間は理論上kickoff後約18.51日以内に有界であり、endpointはこの時刻下限とindexを使って全履歴走査を避ける。

## 7. 版管理と保存境界

- `attention_version` は文字列 `1.0`。
- 算式、入力の必須性、半減期、閾値、大会係数、同点規則のいずれかを変えたら版を上げる。
- 過去の保存済み `base_score` を新しい版で黙って上書きしない。同一 fixture に複数版を保持できる設計にする。
- D1 gate通過前は新テーブルを追加しない。gate通過後の設計追補で `attention_scores`、`match_annotations`、`annotation_citations` をER・保持・archive・index表へ追加する。
- 減衰後の値と個人係数適用後の値は保存しない。
- annotation の `confidence` は `high` / `medium` / `low` とし、fact用の `verification` enumを拡張しない。
- annotation の文字列引用は `record_sources` / `raw_snapshots` に偽装せず、弱い引用として別管理する。

## 8. 再現性テスト

少なくとも次を固定入力 + 固定 `now_utc` で回帰テストする。

1. 同じ入力・同じ時刻なら byte-equivalent な component breakdown と同順位になる。
2. `now_utc` が7日進むと `displayed_score` がちょうど半分になる。
3. Rating未取得、events未取得、G/A競合を0として計算しない。
4. 同一追跡選手をlineup/event/statsから重複計上しない。
5. `base_score = 0` と `base_score = NULL` を区別する。
6. 閾値20.00の境界と同点時の4段階sortが安定する。
7. follow係数を適用しても保存済みbase scoreと中立順位が変化しない。
8. LLM生成文を除去・変更しても数値結果が変化しない。
9. 中立16.00が最大follow係数で20.00となり候補から復帰し、15.99は候補外になる。
10. own goal、missed penalty、VAR取消、延長後PK、直接PKのevent replayがtruth tableどおりになる。
11. `1.005`境界、JSON key順、UTF-8文字列から同じround/hashを生成する。
12. cursorをまたいでも`asOfUtc`が固定され、全page取得後の個人順位がpage sizeやneutral順の境界で変化しない。
13. comeback成立後の再敗戦、両team成立、VAR取消後の再計算、score partsのNULL/不整合を規則どおり処理する。

## 9. 受入条件

- 同一時刻・同一入力で再現でき、UIに `attention_version` を表示または確認可能にできる。
- 対象大会が `scopeVersion` 付きcanonical ID allowlistからだけ決まり、名称推測やJ1混入がない。
- JFW Rating未取得の試合を0点・価値なしとして表示しない。
- 減衰とfollow係数のためにD1 writeが発生しない。
- 数値component breakdownから `reason` / `insights` / `analysis` を参照しない。
- annotationには `confidence` と出典を併記し、数値の根拠として提示しない。
- legacy `jfw-watched-v1` がランキング入力や移行条件に含まれない。
