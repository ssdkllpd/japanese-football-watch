# API-Football → JFW Data Schema v2 mapping v1.0

## 目的

API-Footballの試合データを、海外日本人追跡アプリの`playerMatchStats`を正本とする構造へ安全に変換する。

定期同期はまだ有効化しない。先に以下を満たす。

1. API-Football側のリーグ・クラブ・選手IDをJFWの安定IDへ対応付ける。
2. 取得できる項目と取得できない項目を区別する。
3. 未取得を0に変換しない。
4. 得点イベントがある選手は、個人スタッツ応答が欠けても試合記録と集計から落とさない。
5. 試合単位の事実からシーズン・大会・クラブ別集計を再構築できる状態を保つ。

## 実装

- 項目定義: `config/api-football-schema-v2-map.json`
- APIクライアント: `scripts/api-football/client.js`
- Schema v2変換: `scripts/api-football/schema-v2-mapper.js`
- 実データ項目棚卸し: `scripts/api-football/field-inventory.js`
- 手動Action: `.github/workflows/api-football-inventory.yml`

## 主要エンドポイント

| エンドポイント | 用途 | 位置付け |
|---|---|---|
| `/leagues` | リーグ・シーズンID解決 | 同期前に必須 |
| `/teams` | クラブID解決 | 同期前に必須 |
| `/players/squads` | 日本人選手のprovider ID解決 | 同期前に必須 |
| `/fixtures?id=...` | 結果・イベント・ラインナップ・個人スタッツを含む主取得 | 試合更新の主経路 |
| `/fixtures/events` | 得点・アシスト・カード・交代の補完 | 主取得で欠けた場合 |
| `/fixtures/lineups` | 両チームの先発・ベンチ・フォーメーション・grid配置の補完 | 主取得で欠けた場合 |
| `/fixtures/players` | 試合別個人スタッツの補完・再確認 | 試合終了後の再取得対象 |
| `/players` | シーズン通算の照合 | 試合事実の代替には使わない |

API-Football公式ドキュメントでは、fixture ID指定によりイベント、ラインナップ、統計、選手を含む試合データをまとめて取得できる。実際の契約プランと大会ごとの提供状況は、手動棚卸しで確認する。

## フォーメーションと2種類のRating

- `matchUpdates[].formationData`へ、home/away両チームのフォーメーション、先発、ベンチ、背番号、ポジション、`grid`を保存する。
- `events[].type = subst`では、`player`を交代OUT、`assist`を交代INとして、通常時間と追加時間を双方の選手へ紐付ける。
- `players[].players[].statistics[].games.rating`は`providerRatings.apiFootball`へ保存し、JFW Ratingとは混同しない。
- 追跡日本人のラインナップ選手には安定`playerId`を付ける。非追跡選手を名前だけでJFW記録へ紐付けない。
- 試合詳細では両チームのピッチを表示し、API-Football評価とJFW独自評価を切り替えられる。JFW評価は追跡対象かつ算出可能な選手だけに表示する。
- 個人カードではAPI-Football評価とJFW独自評価を並べる。どちらも未取得・未算出を0へ変換せず`—`とする。

## 選手・監督写真

- APIレスポンスの選手写真URLを優先し、未添付の場合はprovider player IDから公式公開URL `https://media.api-sports.io/football/players/{player_id}.png` を構築する。
- 追跡選手の写真URLは`playerUpdates[].photo`と`playerMatchStats[].photo`へ保存し、選手詳細と試合別個人カードで共用する。
- フォーメーションの先発・ベンチにも同じ写真URLを保存し、ピッチ上の顔写真と背番号を併記する。
- `lineups[].coach`をhome/away各チームの`formationData.teams[].coach`へ保存する。写真が未添付なら公式公開URL `https://media.api-sports.io/football/coachs/{coach_id}.png` を構築する。
- 画像URLはHTTP/HTTPSだけを許可する。画像ファイルが存在しない、または読み込みに失敗した場合は、壊れた画像を出さず選手は背番号・氏名、監督は氏名イニシャルへフォールバックする。
- 公式メディアURLの表示にAPIキーを付けない。APIキーは引き続きブラウザへ渡さない。

## ID方針

- JFWの`playerId`と`matchId`を主キーとして維持する。
- API-Football IDは`providerIds.apiFootball`に保存する。
- 選手名一致で新規更新を紐付けない。
- 追跡選手レジストリに`playerId`、日本語表示名、API-Football player IDを登録してから変換する。
- クラブは「現在所属」ではなく、その試合のteam IDから決定する。

## G/Aの欠落防止

変換器は`fixtures.players[].statistics`だけに依存しない。

1. 個人スタッツの`goals.total`と`goals.assists`を読む。
2. 同時に`events`の得点者・アシスト者を数える。
3. 得点イベントに追跡選手が存在する場合、個人スタッツ行がなくても`playerMatchStats`を作成する。
4. その試合レコードを正本として、既存の再集計処理が`seasonStats`、`competitionStats`、`clubStats`、`clubCompetitionStats`へ反映する。
5. イベントと個人スタッツが矛盾した場合は`ratingConflicts`へ残す。

これにより、後藤啓介のMotherwell戦のように「試合結果には得点があるが、個人成績に入らない」経路を防ぐ。

## missingと0

- 試合が`FT`、`AET`、`PEN`のいずれかで、得点イベント総数が確定スコアと一致した場合だけ、イベント由来のG/A・カード・オウンゴール0を確定できる。空の`events`配列が返っただけでは網羅取得とみなさない。
- 試合前・ライブ中・events未取得では、イベントがないことを0と解釈しない。
- 個人スタッツに存在しない項目は`missingFields`へ入れる。
- 取得不能項目は暫定0で埋めない。
- 得点だけ確定して他項目が未取得でも、得点は即時反映し、他項目はmissingのまま保持する。

## 現時点の主な提供ギャップ

少なくとも現在の標準的なfixture player statisticsだけでは、以下は直接確定できない、または全ポジションで一貫して取得できない。

- クリア数
- 空中戦勝利数・総数
- 決定機逸
- ポゼッションロスト
- ハイクレーム
- 失点直結ミス
- フィールドプレーヤーの出場中失点

これらはmissingとして再取得対象に残す。別エンドポイントや別ソースが網羅的と確認できるまでは0にしない。

## 手動項目棚卸し

GitHub Actionsの`API-Football Field Inventory`を開き、API-Football fixture IDを入力して実行する。

出力するのは以下だけで、APIキーと生レスポンスは表示しない。

- fixture ID、ステータス、league ID、season
- JFW対象項目ごとのprovider path存在有無
- 残りリクエスト数

大会や試合によって提供項目が異なるため、最低でも各追跡リーグから完了済み試合を1件ずつ確認してから定期同期へ進む。

## 定期同期を有効化する条件

- 追跡リーグ・クラブ・選手のprovider ID対応表が完成している。
- 各リーグの完了済みfixtureで項目棚卸しが完了している。
- 得点イベントのみ、個人スタッツのみ、両方あり、両方不一致のテストが通る。
- missingが0へ変換されないテストが通る。
- 後藤啓介の既存1得点が全4集計へ反映される回帰テストが通る。
- API使用量のsoft stopと再取得優先順位が同期処理へ組み込まれている。
- 更新結果が内部整合性テストを全て通る。

## 参照

- API-Football v3 documentation: https://www.api-football.com/documentation-v3
- JFW player model: `docs/player-tracking-data-model-v1.0.md`
- JFW workflow policy: `state/workflow_policy.json`
