# API-Football 反映済み試合バックフィル

## 目的

JFWに結果を反映済みの試合だけをAPI-Footballで補完し、フォーメーション、スタメン、ベンチ、交代、監督、選手写真、API-FootballレーティングおよびJFW Rating入力を保存する。

## 対象の固定

- `config/api-football-existing-results.json`に記載した試合のみを対象とする。
- 保存済みデータ上で`status = verified`かつ最終スコアを持つことを実行時に再検証する。
- 現在の対象は27試合。保存済み対象とマニフェストが一致しなければAPIリクエスト前に停止する。
- Proプランの履歴アクセスを使い、マニフェストに固定した9日だけを検索する。`last`、`next`、最新フィード、日程済み試合は要求しない。

## リクエストとクォータ

1. 確認済みのprovider fixture IDは`/fixtures?id=`で再検証し、未解決分はマニフェストの固定日付ごとに`/fixtures?date=`で解決する。
2. 解決済みfixture IDに限り、`/fixtures/events`、`/fixtures/lineups`、`/fixtures/players`を取得する。
3. ラインナップに監督が欠ける場合だけ`/coachs?team=`を取得し、対象日を含む在任期間が一意に一致した監督と写真を補完する。
4. Proプランの300 requests/minuteおよび5 requests/secondを下回るよう、呼出し間隔を300ミリ秒以上にする。
5. 日次7,500件のうち最低100リクエストを残す。1回で完了しない場合は状態を保存して次回に続きから再開する。

## 保存と安全性

- Schema v2へ変換したデータだけを`data/2026-27/backfill/api-football-existing-results.json`へ保存する。
- fixture IDと再開状態を`state/api-football-existing-results.json`へ保存する。
- APIキーおよび生レスポンスはリポジトリ、Actionsログ、ブラウザへ保存・表示しない。
- チームはスコアと明示的な別名の両方が一致する場合だけfixtureへ紐付ける。
- 選手は対象試合内の明示的なローマ字別名が一意に一致した場合だけprovider IDを登録する。未取得や曖昧な値は推測しない。
