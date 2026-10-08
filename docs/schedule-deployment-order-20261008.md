# 日程変更処理の展開順序（2026-10-08）

公開Workerはmainへの変更で自動デプロイされます。従来はmigrationとAdmin Workerの展開を待たなかったため、SCHED-R4の導入順序を保証できませんでした。`public-worker-deploy.yml`を以下の依存関係に変更しました。

1. `preflight`: GitHub `d1-staging`環境の資格情報、32文字以上の`PUBLIC_DATE_AUDIT_TOKEN`、Admin対象、schema lock、公開Worker対象をローカルで検証します。remote操作はありません。
2. `provision`: 同じコミットの`d1-staging-provision.yml`を呼び、migration適用 → Admin Worker展開 → Admin secret設定 → 保護された読取による公開予算確認の順に実行します。
3. `deploy`: `provision`の成功後だけ公開Workerを展開し、provider secretと監査secretを設定します。通常の公開読取・CORS・D1読取に加え、一般／大会別の`fresh=1`を同じ監査tokenで読み、`no-store`、D1読取フラグが有効ならD1由来、日付・試合ID・大会ヘッダーを確認します。

`needs`の標準成功条件を使い、前段が失敗・取消・スキップなら後段は実行しません。`always()`や`continue-on-error`による展開継続はありません。呼出元の`public-worker-deploy`と呼出先の`d1-staging-write`は別のconcurrency groupで、同一groupを待つ相互待機を作りません。Admin・migration・対象設定・関連スクリプトの変更もmainでこの展開を開始します。

## マージ前

- 日程同期と15分更新を停止したままにします。実データの限定検証を終えるまで有効化しません。
- GitHubの`d1-staging`環境に32文字以上のランダムな`PUBLIC_DATE_AUDIT_TOKEN`をsecretとして設定します。値をvars、画面、PR、ログ、レビュー資料に載せません。
- 既存の`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`ADMIN_INGEST_TOKEN`、`API_FOOTBALL_KEY`と、対象を固定するvarsも必要です。監査secret未設定／短すぎる場合はmigration前のpreflightで停止します。
- このworkflowの変更をレビューしてからPR #123のマージを判断します。マージは実環境へのmigrationとWorker展開を開始する操作です。PR #122はマージしません。

## マージ後

- マージしたSHAの`Deploy Public Worker`で3ジョブとfresh検証の成功を確認します。公開Workerの監査secretはworkflowが設定し、日程同期は同じGitHub環境secretを使います。
- 失敗時は原因を直し、同じレビュー済みSHAのworkflowを再実行します。migrationが一部適用済みなら履歴を確認して再開し、手動で履歴を消しません。後続ジョブだけを再実行して成功した前提を無視したり、旧コミットのAdmin／公開Workerを再展開したりしません。
- 公開Worker展開後の検証に失敗した場合は、既存のD1公開読取OFFへの退避を試みます。これは旧コード・migrationの巻戻しではなく、退避が成功してもworkflowは失敗のままです。退避用の証跡ディレクトリは公開Worker展開前に作ります。
- `fixture_schedule_repair_status`、SCHED-R3の読取SQL、保留1552141と最新previewを確認します。必要な修復は調査・証跡ハッシュ付き承認を経て行います。
- 日付をまたぐ変更2件以上の限定実行でexecutor、repair report、fresh監査を確認し、旧・新日付の一般／大会別一覧をブラウザで確認します。日程同期を先に、15分更新は結果・日付移動の検証後に有効化します。

## 今回の実環境読取

2026-10-08 15:08 JSTの読取専用inventory再実行（run `36508632712` / job `113175420075`）では、`jfw-football-staging`はmigration 0009までで0010–0012は未適用でした。対象10大会のfixturesは3420、publishedFixtureDetailsは575、外部キー違反とシーズン範囲外の日付は各0件です。これは展開済みの日程変更処理やD1/R2一致の検証結果ではありません。

今回の修正・テストではremote migration、Worker展開、secret設定、自動更新の有効化、API-Football呼出しは行いません。実環境への展開と限定実行は別の実施判断です。

## ローカル検証

全体716件中714成功・失敗0・既存TODO 2。外向きsocketを遮断して実行し、遮断フックの試行記録は0件です。重点38件はすべて成功し、実YAMLから取り出したbashを実行して資格情報欠落・短いtoken・対象不一致、secret設定失敗、fresh読取の認証失敗・キャッシュ応答・R2退避・日付／大会／fixture不一致を確認しました。remoteコマンドとHTTPはスタブです。GitHub上での失敗・取消によるジョブskipは実環境へ展開せず、依存関係の静的検査で確認しています。

29件のYAMLと160個のbashブロックの構文、schema lock、差分の空白検査も成功しました。actionlint 1.7.12で呼出元・呼出先を検査し、既存の`queue: max`への未対応診断だけを除外して他の診断0件です（[既知の未対応](https://github.com/rhysd/actionlint/issues/657)）。[同じリポジトリの相対参照は同じコミットを使用するGitHub仕様](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)に従い、可変の`@main`参照は使いません。
