# Data App v2 UI ワイヤーフレーム基準 v1.0（レビュー案）

状態: **Proposed — 独立レビュー完了まで実装禁止**
対象: Data App v2 の基本画面
作成日: 2026-08-26
入力: `デザイン情報確認フォーム (3)(1).zip`
関連文書: `data-app-v2-direction.md`、`screen-flow-v2-d1-v1.0.md`、`data-storage-d1-r2-design-v1.0.md`

## 1. 採用判断

`Hi-Fi Mockups (FotMob Style).dc.html` を視覚方向の基準にする。`Wireframes.dc.html` は情報構造の確認用、`Hi-Fi Mockups.dc.html` の Broadsheet 案はファイル内の記載どおり非採用とする。

この基準は新機能を追加するものではない。既存の Core football data、Japanese tracking overlay、JFW Rating、follow、視聴価値ランキング、tracking insightsを、FotMob を参考にした情報階層で表示するためのものとする。

## 2. 基本画面と実装段階

| Mock | 画面 | 採用 | 実装段階 |
|---|---|---|---|
| 1a | 試合ホーム（ライト/ダーク） | 採用 | Phase 1 parity |
| 1b | 国 → リーグ → クラブ | 採用 | リーグは Phase 1、クラブ導線は Phase 2 |
| 1c | クラブ詳細 | 採用 | Phase 2 |
| 1d / 2b | 一般選手詳細 + 追跡 overlay | 2b の統合構造を採用 | Phase 2 |
| 1e | 試合詳細・ラインナップ/フォーメーション | 採用 | Phase 1 parity |
| 1f | チームスタッツ/選手評価 | 採用 | Phase 1 parity |
| 1g | イベント・タイムライン | 採用 | Phase 1 parity |
| 2a | 日本人タブ | 採用 | Phase 1 parity |
| 2c | 共通検索 | 採用 | Phase 2 |
| 3a | JFW Rating 要因分解 | 既存 `mustExpose` の表示として採用 | Phase 1 後半 |
| 4a / 4b / 4c | **利用者が貼り付ける**外部AI分析の保存・表示 | **不採用 / 今回の範囲外** | 別要件として承認されるまで route/API/DB を作らない |

監視パイプラインが生成する `insights` / `analysis` / `topMatches.reason` は `state/product_scope_v2.json` の `tracking_insights` に含まれる承認済み機能であり、上表4a / 4b / 4cの対象外とする。

## 3. 情報アーキテクチャ

- 主ナビゲーションは `試合`、`リーグ`、`フォロー中`、`日本人`、`その他` の5つを維持する。
- 共通検索は6番目の主ナビにせず、header から開く overlay route とする。
- 試合詳細は `概要`、`ラインナップ`、`イベント`、`スタッツ`、`選手評価` の5 tab とする。
- JFW Rating の要因分解は別の主画面を増やさず、`選手評価` tab から選手行を開く detail state とする。route は `#/fixtures/{fixtureId}?tab=ratings&player={playerId}&ratingMode=jfw` を正本とする。
- クラブ/選手詳細は試合・順位表・lineup から相互遷移し、戻ると元の tab、filter、scroll position を復元する。

## 4. 日本人表示と追跡範囲

generic Core 画面の `JP` badge と Japanese tracking overlay を分ける。

| 表示 | 意味 |
|---|---|
| generic 画面の `JP` | Core player の国籍が日本。追跡対象であることを意味しない |
| `日本人` tab、JFW Rating、注目度、追跡集計 | `jfw_player_id` を持ち、configured overseas leagues の追跡期間内である選手だけ |

J1 は Core の大会・クラブ・選手として表示できるが、海外日本人追跡 workflow には含めない。Mock の町田/J1と `JP` はレイアウト用の例であり、J1選手へ JFW Rating や追跡 badge を出す仕様ではない。

## 5. 視聴価値ランキング

視聴済みボタンと `jfw-watched-v1` の移行は行わない。個人の視聴状態は保持せず、時点ごとの視聴価値ランキングだけを表示する。

- 順位は決定的に算出する数値であり、算式と版は Git の `docs/attention-score-v1.0.md` に置く。LLM の判断を順位の出どころにしない。
- 現在のD1 gate通過後の設計追補で、D1には時刻非依存のbase scoreだけを保持する。経過時間による減衰は公開Workerの純関数としてread時に適用し、減衰のためにD1へ書き戻さない。
- 一覧は base score ではなく減衰後の値で並べ、閾値未満は表示しない。時間経過で自然に一覧から消えることを「消化」の代替とする。
- Workerは最大follow係数から逆算した中立score 16.00以上を候補として返す。フォロー中のクラブ/選手による重み付けはブラウザ側で適用し、個人score 20.00以上へ絞って並べ直す。サーバへ個人状態を送らない。
- 説明文（`reason` / `insights` / `analysis`）は監視パイプライン生成のまま維持し、注釈として表示する。数値の根拠としては扱わず、`confidence` と出典を併記する。
- 視聴手段（`watch`）は個人状態ではない試合付随情報として試合行に表示する。配信期限が確認できないラベルを「現在視聴可能」と断定しない。
- 視聴済み状態そのものは、認証と端末間同期の設計後に follow sync と同じ Phase で再検討する。
- 現行legacy annotationにはmetadata欠落があるため、D1設計追補で人手確認済み`confidence`とcitationを補完する。未解決annotationが残る間はlegacy JSONを縮退しない。

## 6. 視覚トークン

| 用途 | Dark | Light | 意味 |
|---|---|---|---|
| background | `#0c0f12` | `#f1f3f5` | page |
| surface | `#14181d` | `#ffffff` | card |
| primary text | `#f3f5f7` | `#15191e` | 本文 |
| secondary text | `#9aa4af` | `#66717d` | 補足 |
| green | `#77e8a7` | `#087a43` | active、follow、positive rating |
| red | `#ff5b6e` | `#d8344d` | LIVE、重大エラー |
| amber | `#e4b957` | `#9a6b00` | 推定、注意、カード |

色だけで状態を伝えず、`LIVE`、`配置は推定`、`未取得` などの文言/アイコンを併記する。theme は `その他` から変更でき、OS preference を初期値とする。

## 7. モバイル/デスクトップ制約

- 360 px mock は情報構造の基準であり、実装を固定幅にしない。主要 container は `width: 100%` とし、320 px から横スクロールなしで利用できるようにする。
- 380 px の formation mock も viewport 幅へ縮む。pitch は比率を維持し、選手 label が重なる場合は情報を省略せず tap/focus detail へ退避する。
- 本文/主要行は14 px以上、補足は12 px以上を基本とし、出典などでも11 px未満を常用しない。
- tap target は原則44 × 44 CSS px以上。5つの試合詳細 tab は狭幅で均等圧縮せず、横スクロール可能な tablist にする。
- desktop は同じ route/contract を使い、一覧 + detail または主情報 + 補助情報の2 columnへ展開する。モバイル専用情報を作らない。

## 8. データ状態

ワイヤーフレームに描かれていない次の状態も必須であり、`screen-flow-v2-d1-v1.0.md` §8 を優先する。

- loading / stale request guard
- 取得済み空集合
- `not_fetched` / `provider_missing` / `not_applicable`
- archive loading
- compact fixture はあるが detail unavailable
- entity 404、review required、429、offline/5xx、R2 degraded response

表示値 `0` と欠落を同じ見た目にしない。JFW Rating 要因分解でも未取得項目を `±0.00` と表示せず、`未取得` とする。

## 9. 受入条件

- 5つの主ナビと試合詳細5 tab が mobile/desktop で同じ意味を持つ。
- ライト/ダークの両方で primary/secondary/LIVE/推定が判別できる。
- 320 px で page 全体の横スクロールが発生しない。
- keyboard focus、44 px tap target、tab の横スクロールが機能する。
- generic `JP` と tracked/JFW 表示が混同されず、J1を tracking workflow に含めない。
- 視聴価値ランキングが同一時刻・同一入力で再現でき、`attention_version` を明示できる。
- 中立16.00〜19.99の候補がfollow係数後に20.00以上なら表示され、先にサーバで欠落しない。
- 減衰の適用が read 時であり、順位表示のために D1 への書込みが発生しない。
- JFW Rating が未取得の試合の attention が `0` ではなく「未算出」として扱われ、ランキングから除外されるが価値0とは表示されない。
- 説明文に `confidence` と出典が併記され、数値の根拠として提示されない。
- legacy縮退前に全annotationの`confidence`とcitationが人手確認され、未解決metadataが0件である。
- API/JFW rating switch と要因分解が、欠落を0へ変換せず表示する。
- 利用者が貼り付けた外部AI分析を保存する route/API/DB/UI が存在しない。
