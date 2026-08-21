# API-Football 反映済み試合バックフィル

## 目的

JFWに結果を反映済みの試合だけをAPI-Footballで補完し、フォーメーション、スタメン、ベンチ、交代、監督、選手写真、API-FootballレーティングおよびJFW Rating入力を保存する。

## 対象の固定

- `config/api-football-existing-results.json`に記載した試合のみを対象とする。
- 保存済みデータ上で`status = verified`かつ最終スコアを持つことを実行時に再検証する。
- 現在の対象は27試合。保存済み対象とマニフェストが一致しなければAPIリクエスト前に停止する。
- Freeプランでは過去日付と2026年シーズンを直接検索できないため、明示した対象チームの`last=20`をfixture ID解決だけに使用する。返却された別試合は保存・反映せず、今後の日程とJ1は取得しない。

## リクエストとクォータ

1. `/teams?search=`を明示的な別名で一意に解決し、対象チームの`/fixtures?team={id}&last=20`からprovider fixture IDを探す。保存済みのホーム・アウェイ・スコアが一致した試合以外は破棄する。
2. 解決済みfixture IDに限り、`/fixtures/events`、`/fixtures/lineups`、`/fixtures/players`を取得する。
3. Free planの10 requests/minuteを超えないよう、呼出し間隔を6.5秒以上にする。
4. 日次枠を最低20リクエスト残す。1回で完了しない場合は状態を保存して次回に続きから再開する。

## 保存と安全性

- Schema v2へ変換したデータだけを`data/2026-27/backfill/api-football-existing-results.json`へ保存する。
- fixture IDと再開状態を`state/api-football-existing-results.json`へ保存する。
- APIキーおよび生レスポンスはリポジトリ、Actionsログ、ブラウザへ保存・表示しない。
- チームはスコアと明示的な別名の両方が一致する場合だけfixtureへ紐付ける。
- 選手は対象試合内の明示的なローマ字別名が一意に一致した場合だけprovider IDを登録する。未取得や曖昧な値は推測しない。
