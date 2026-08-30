# D1 Phase 2 実装レビュー結果 R2

- レビュー基準時刻: 2026-08-30 14:15 JST
- Repository: `ssdkllpd/japanese-football-watch`
- コードレビュー範囲: `3f9fe90..0e74f2c`
- レビュー時のremote branch HEAD: `4b3809f`
- 注記: `0e74f2c..4b3809f`の2 commitはレビュー結果file追加とpacket更新のみであり、コードレビュー範囲への影響はない。

## Verdict

```text
Verdict: CHANGES_REQUIRED
BLOCKER: 1
MAJOR: 2
MINOR: 5

Phase 3 implementation may start: NO
Production cutover may start: NO
```

## Findings

### BLOCKER: readiness expectationsの過少宣言でfixtureRecords gateが通る

対象: `scripts/d1/phase2-readiness.js:112-140`

`expectedScope()`はIDの存在、部分集合関係、plan fixtureとscope由来fixtureの一致だけを検証し、宣言集合の下限を保証していない。`fixtureRecordIds`を1件だけ宣言すると、残りのsnapshot recordはlinkageもfact parityも検証されず`not_applicable`になり、gateを通過できる。

`fixtureRecordIds`は宣言値を信用せず、`snapshot.data.playerMatchStats`全件から導出する。不一致のplanはvalidationで拒否する。全120件のparityが通らない場合は除外せず、移行ギャップとしてreportする。

### MAJOR: eventsのsource配列順がD1 round-tripで保存されない

対象: `scripts/d1/fixture-repository.js:91-93`

importerはsource indexを`event_order`へ保存しているが、repositoryは`elapsed`、`extra_minute`、`event_order`の順で並べ替える。このためsource JSONが時系列順でない場合、D1読戻し順が変化してshadow parityが閉じ続ける。

source配列順をcontractとして保存する場合、repositoryは`event_order`単独で復元する。別案として時系列順をimporterの不変条件にする場合はfail closedとrunbook明記が必要だが、本修正ではsource配列順の厳密保存を採用する。

### MAJOR: rating／tracked player／aggregate expectationsも過少宣言できる

対象: `scripts/d1/phase2-readiness.js:119-132`

以下をsnapshotから導出し、plan値は照合のみに使う。

```text
fixtureRecordIds   == { r.recordId | r ∈ snapshot.data.playerMatchStats }
trackedPlayerIds   == { r.playerId | r ∈ snapshot.data.playerMatchStats }
ratingRecordIds    == { r.recordId | ratingVersion または jfwRating が宣言済み }
aggregatePlayerIds == trackedPlayerIds
```

これによりcrosswalk、Rating、aggregateの検証対象をplanから静かに除外できないようにする。

### MINOR: expected Rating件数がproduct seasonとrating versionを落としている

対象: `scripts/d1/tracked-player-rating-importer.js:195-204`

`ratingCountForExpectedEntries`は対象product seasonでJOINし、`player_record_id`と`rating_version`の組で期待値と照合する。

### MINOR: lineup entry_orderにDEFAULT 0がある

対象: `migrations/0001_d1_core.sql:195`

`DEFAULT 0`を外し、importerが順序を渡し忘れた場合は`NOT NULL`違反で即時に失敗させる。

### MINOR: ordered array判定がpath非依存

対象: `scripts/d1/fixture-shadow-compare.js:8,24`

key名だけではなく、`events`、`lineups[].startXI`、`lineups[].substitutes`のcontract pathに限定してordered比較する。

### MINOR: 補正定義の三者照合がimport時に効かない

対象: `scripts/d1/fixture-bundle-importer.js:530-535`

canonical fixture import時にもGit補正定義fileを必須入力にし、bundleとの一致を確認してから書込みを開始する。readinessでは従来どおりGit／JSON／D1の三者を照合する。

### MINOR: git diff --checkの記載

`3f9fe90..0e74f2c`ではpacket末尾の空行で失敗するが、`4b3809f`で解消済み。追加修正は不要。

## 再検証で確認済みの事項

- `node --test tests/*.test.js`: 246 tests / 244 pass / 0 fail / 2 todo / exit 0
- 既知TODOはbackfill idempotency 2件
- `tracking_status` CHECK値とbackfill生成ロジックは一致
- 補正定義のGit／JSON／D1三者照合とDTO注入廃止を確認
- `correctionsPath`にもplan directory脱出防止が適用済み
- linkとparityは1回計算して各gateで共有
- 初回9 findingのうちMINOR 4件と補正注入MAJORは解消済み
- lineup順序は解消済み

## 再レビュー条件

修正後は`4b3809f..<new HEAD>`をdiff-focusedで再レビューする。canonical bundle、Git補正定義、ローカルD1、coverage、snapshot-derived expectationsを照合した統合reportが揃うまで、Phase 3開始とProduction cutoverは禁止する。
