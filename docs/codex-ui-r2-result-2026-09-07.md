# Data App v2 UI — R2 修正結果

作成日: 2026-09-07。比較元: `187d7744524049c34724d407b9c682b76218dc4a`。修正ブランチ: `fix/data-app-v2-ui-r2`。実際のレビュー HEAD は同梱 `REVIEW-README.md` に記録する。

R1 と補完レビューを受けて、こちらの作業環境で UI を修正した。R2 の独立レビューに渡せる差分と実行テストを用意した段階であり、独立レビューの合格・本番接続・デプロイ完了を意味しない。

## 主な変更

- 履歴を各エントリの ID・戻り先・スクロール位置で管理する。検索・詳細を往復しても元の日付、filter、tab を維持し、遅い通信で別画面を描き直さない。
- 画面テストを jsdom による DOM・イベント・URL の検証へ置換した。監督非表示、片側ラインナップ欠落、両チーム評価の混在を、意図的な変更によって検出できることも確認した。
- 実測 0、未取得（破線・パルス）、非該当（`provider_missing` を含む実線・パルスなし）、取得済みの空集合（本文の「該当なし」）を分ける。両チームの評価を分け、試合の 5 タブとパネルを対応付ける。
- フォローの永続化は ID のみに移行した。表示名は取得済みデータから解決し、未取得の参照を削除済みと誤認しない。フォロー操作で詳細 API を再取得しない。
- 日本人試合の対象判定は canonical ID と明示された追跡期間を使う。対応情報がなければ対象不明と表示する。日本人画面では保有する大会別集計を切り替えられ、対象外移籍後の取得済み成績を別枠に残す。現在所属で過去成績を再分類しない。
- 視聴価値は、未接続を未算出と断定しない。将来の候補 API 向けに、全ページ取得、snapshot 整合確認、409 後の破棄・再取得、ID による端末内係数、整数による HALF_UP 丸めを用意した。減衰や基礎スコア計算をブラウザへ移していない。
- 主ナビを文字ラベルにし、正しい standalone の補助アイコンを使用した。角丸を 8/12/16/999 のトークンへ集約した。PST は延期として分け、中止と終了を排他的に表示する。

## 検証方法と結果

Node v24.19.0 / npm 11.9.0 を使用した。CI は既存の Node 22 のまま、`npm ci --ignore-scripts` を追加した。この作業環境で Node 22 を実行したとは主張しない。

```sh
npm ci --ignore-scripts
npm run test:ui
npm test
```

- 修正前の既存テスト: 422 件中 420 pass、0 fail、2 TODO。
- R1 のまま追加した初期 DOM テスト: 9 件中 3 pass、6 fail。結果は同梱 `evidence/r2-tests-before.log`。通った既存挙動も残したうえで、不具合を検出した。
- 最終 UI テスト: 39 件。実数は同梱のログを正とする。
- 最終全体テスト: 437 件中 435 pass、0 fail、2 TODO。TODO は比較元から存在する backfill の冪等性・membership replay drift の2件。Node のログ末尾に drift の失敗詳細が出るが、集計上の fail は0で終了コードも0。
- 構文チェック、`git diff --check`、2 つの入口 HTML の一致を確認した。
- mutation 3 件（監督非表示 / アウェー lineup 除去 / 評価混在）はすべてテスト失敗として検出し、変更を元に戻した。

jsdom では実装スクリプトと CSS を読み込み、クリック・入力・IME・履歴・描画 DOM を検証する。通信は fixture contract に沿ったテストデータで置換する。スクロールは履歴に保持する座標と復元要求を検証するもので、実際の画面高やブラウザのスクロール制限を測っていない。

Chromium の取得は `cdn.playwright.dev` への通信タイムアウトで失敗した。320/375/390/768px、ライト/ダーク、実端末、描画上の横はみ出し、写真読み込みを含む見た目は未確認。スクリーンショット合格として扱わない。

## 接続と公開設定

入口 HTML は `app-v2-config.js` を読み込む。設定生成は次で行う。

```sh
FOOTBALL_V2_PUBLIC_API_BASE=https://APPROVED_PUBLIC_API_ORIGIN node scripts/v2/build-ui-config.js
```

上の URL は記入位置の例であり、実在の接続先ではない。生成器は HTTPS の origin のみを許可する。本番オリジンでは query/localStorage の API 上書きを読まない。プレビューの上書き先も設定内 allowlist に限定する。

提供ソースには公開用 Worker origin の確定値がないため、同梱設定の `apiBase` は `null`。未確認の URL や admin Worker を代用していない。固定設定を読み込んだ本番オリジンの DOM テストでは、query/localStorage がなくても設定先へ実際に fetch が向くことを検証した。本番への接続成功は未確認であり、M11 の運用上の接続は未解消。

`attentionEnabled` / `trackingEnabled` は false。Worker の D1 切替 flag、DB schema、ingest、公開設定は変更していない。GitHub への push・merge・デプロイは行っていない。

## レビュー ID 対応表

「修正済み」は今回の自己検証であり、独立レビューの close 判定ではない。繰越と未解消を修正済み件数へ含めない。R1 補完の N03 取り下げ、N11→A04 統合、N01→A11 の訂正を反映し、元レビューの合計件数は再利用しない。

| ID | 状態 | 変更・根拠・残る確認 |
|---|---|---|
| B01 | 正本復元・同梱 | 正しい 8,027,495 bytes の standalone を使用。原本バイト列を保持しチェックサムを再確認。 |
| M01 | 修正済み | `tests/app-v2-runtime.test.js` の DOM/URL 検証と mutation 3 件。静的シェルテストは入口一致などの構造確認へ限定。 |
| M02 | 修正済み | `renderMatchesIfVisible` が route kind を見る。遅い date response 後もクラブ詳細を保持。 |
| M03 | 修正済み | `app-v2-history.js`。連続 back と繰り返し往復を検証。 |
| M04 | 修正済み | 履歴エントリの出発 URL を利用。`leagues` の builder は canonical `competitions`。 |
| M05 | 修正済み | documented legacy hash/query を一度だけ replace。一意な完全一致 Core ID のみ解決。曖昧な名前は親画面へ。 |
| M06 | 実装済み・実ブラウザ確認待ち | エントリ単位の座標保存と非同期再描画後の復元要求を DOM テスト。実レイアウトでの復元は未確認。 |
| M07 | 部分修正・接続未解消 | ID/時点/scope 判定を実装し名前照合を撤去。現行移行データは Core team/player crosswalk と公開追跡期間を持たない。フィルターが実データを完全に返す段階ではない。 |
| M08 | 部分修正・Phase 1 後半接続待ち | 未取得表示、全候補読み込みと cursor 再取得を実装・テスト。配信 endpoint、公開 DTO、Worker 減衰計算と除外内訳は未接続。 |
| M09 | UI 修正済み・実データ接続待ち | J1/対象外は非該当、対象判定不明は未取得。明示された追跡期間の fixture と選手のみ JFW を表示。 |
| M10 | 表示修正済み・実配信情報確認待ち | fixture/大会の試合行と詳細に watch。attention の明示された未算出・未取得・非該当・算出済みを区別。順位外だけで未算出にしない。 |
| M11 | 設定経路修正済み・運用接続未解消 | 生成済み config を入口から読み込む。公開 Worker origin が未提示のため実設定は空。 |
| M12 | UI 修正済み・一覧 API 拡張待ち | 複数の既知 season では切替が機能し tab を維持。1 件だけなら読み取り専用表示。全利用可能 season の取得契約は未接続。 |
| N01 | A11 に統合 | 補完の訂正を採用。 |
| N02 | 修正済み | 試合/大会 tab の `aria-controls` と `tabpanel` を対応付け。 |
| N03 | 取り下げ | 11px 全禁止という元指摘は適用しない。 |
| N04 | 修正済み | seasonless legacy 大会の順位表は非該当。 |
| N05 | 修正済み | フォロー時は表示だけ更新。fixture の再 fetch が増えないことを検証。 |
| N06 | 修正済み | clubStats の raw JSON を出場・得点・アシスト・出場分の表示へ変更。 |
| N07 | Phase 2 繰越・部分改善 | 取得済み Core lineup/playerStats の選手を registry なしで表示可能。一般選手 detail endpoint は未接続。 |
| N08 | Phase 2 繰越 | 共通検索は取得済みの範囲であることを明示。全体検索・alias 検索の API は未接続。 |
| N09 | 修正済み | input node を保持し結果領域だけ更新。IME 中は route 更新を待つ。 |
| N10 | 修正済み | 欠落/不正 date を canonical な日付へ replace。 |
| N11 | A04 に統合 | 永続化内容の修正をまとめて扱う。 |
| N12 | 修正済み | 一覧/試合詳細の見出しを明示更新。往復テストで確認。 |
| N13 | 修正済み | `#/` と実在 legacy hash の query を処理。未知裸 hash は 404 のまま。 |
| N14 | 修正済み・Phase 2 データ範囲は維持 | 80 件の黙った切り捨てを撤去。クラブの空表示を検索助言と分け、取得範囲を明示。 |
| A01 | 修正済み・対象画面の再レビュー待ち | `valueCell`/`emptySection`、明示的な section/field presence、0 と空集合の検証。 |
| A02 | 修正済み | home/away team ID ごとの評価セクション。混在 mutation を検出。 |
| A03 | 部分修正 | シーズン表示と保有する公式大会別 aggregate の切替。既存の明示済み competition alias 設定を使用し、新規 ID を名前から推測しない。全 season 配信と未対応表記の統合は未接続。 |
| A04 | 部分修正・参照解決 API 待ち | 保存は ID のみ。キャッシュ不在は参照未取得。authoritative な削除/統合応答に基づく「取得できないフォロー」は endpoint 未接続。 |
| A05 | 表示実装済み・実 DTO 待ち | 注釈の confidence と出典表示を用意。候補 API 未接続のため実データ併記は未確認。 |
| A06 | 実装済み・見た目確認待ち | 24×24/currentColor の補助 SVG、文字ナビ、絵文字フォールバック撤去。 |
| A07 | 修正済み・見た目確認待ち | high 無表示、medium 推定、low 低確度/70%、none グレーピッチ・配置なし。文字 lineup と coach は保持。 |
| A08 | 修正済み | 対象外枠に過去の rankingEligible な aggregate を残す。現所属が J1 のケースを検証。 |
| A09 | UI 修正済み・全 season API 待ち | 既知の利用可能 season への復帰導線と検索導線。未取得 season を架空の候補にしない。 |
| A10 | 実装済み・見た目確認待ち | 8/12/16/999 トークン。円形 50% は維持。 |
| A11 | 修正済み・見た目確認待ち | CANC/ABD/AWD/WO のハッチ、PST 分離、final と cancelled の排他を検証。 |
| A12 | A01 と合わせて修正 | 未取得の破線/パルス、reduced-motion 時は停止。 |
| A13 | A01 と合わせて修正 | 取得済み空集合を本文「該当なし」へ。未配信の detail は空集合と断定しない。 |
| A14 | 表示修正済み・実 API 確認待ち | 409 review required、archive pending、429、404 を分岐し再試行/検索を用意。開発用状態カタログは製品へ追加しない。 |
| A15 | 部分修正・Phase 2 繰越あり | 節/更新時刻、日本語指標、取得済み国籍・生年月日・出場分・退場・配信、クラブ取得済み直近/今後を追加。全履歴と alias 検索は未接続。 |
| A16 | 実装済み・見た目確認待ち | 主な試合/選手/評価行を15pxへ。補足の11pxは用途を限定して維持。 |

## 残件の境界

1. 公開用 API origin を確定し、生成 config を実環境へ配置すること。今回は実接続確認をしていない。
2. Core ID crosswalk、公開 tracking periods、Attention の immutable candidate DTO と除外内訳を提供すること。UI の仮定を `docs/attention-score-v1.0.md` §6 の配信契約へ最終整合させる。候補取得のページ配列名 `candidates`、関与 ID 配列名 `involvedPlayerIds` は今回のテスト DTO 上の名前であり、公開済み endpoint と同一とは主張しない。
3. Phase 2 のクラブ/一般選手詳細、全体検索と aliases、全シーズン列挙、参照先の削除/統合を判定する取得 API。
4. 実ブラウザ・実端末とライブ API での確認。特に細幅、長い名称、タブ横スクロール、履歴復元、写真失敗時のレイアウト。
5. ワイヤーフレーム側の UIWF-R5-001 / UIWF-R5-002 / R4-005 は Claude Design 側の残件。今回、原本自体は変更していない。

これらを自己判断で「承認済み解消」へ分類しない。R2 では、今回修正した UI 挙動と、未接続/別 Phase の残件を分けて判定してほしい。
