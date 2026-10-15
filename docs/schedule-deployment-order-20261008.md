# 日程変更処理の展開順序（2026-10-08）

公開Workerはmainへの変更で自動デプロイされます。従来はmigrationとAdmin Workerの展開を待たなかったため、SCHED-R4の導入順序を保証できませんでした。`public-worker-deploy.yml`を以下の依存関係に変更しました。

1. `preflight`: GitHub `d1-staging`環境の資格情報、32文字以上の`PUBLIC_DATE_AUDIT_TOKEN`、Admin対象、schema lock、公開Worker対象をローカルで検証します。remote操作はありません。
2. `provision`: 同じコミットの`d1-staging-provision.yml`を呼び、migration適用 → Admin Worker展開 → Admin secret設定 → 保護された読取による公開予算確認の順に実行します。
3. `deploy`: `provision`の成功後だけ公開Workerを展開し、provider secretと監査secretを設定します。通常の公開読取・CORS・D1読取に加え、一般／大会別の`fresh=1`を同じ監査tokenで読み、`no-store`、D1読取フラグが有効ならD1由来、日付・試合ID・大会ヘッダーを確認します。さらに両ルートへtokenなし・誤tokenの4要求を送り、すべて401・`no-store`で拒否されることを確認します。

`needs`の標準成功条件を使い、前段が失敗・取消・スキップなら後段は実行しません。`always()`や`continue-on-error`による展開継続はありません。呼出元workflowの`public-worker-deploy`と、呼出先のAdmin展開ジョブの`d1-staging-write`は別のconcurrency groupです。呼出先のworkflow単位のlockは削除し、ジョブに`queue: max`・`cancel-in-progress: false`を設定しました。呼出しジョブに同じlockを重ねないため相互待機を作りません。Admin・migration・対象設定・関連スクリプトの変更もmainでこの展開を開始します。

## マージ前

- 日程同期と15分更新を停止したままにします。実データの限定検証を終えるまで有効化しません。
- GitHubの`d1-staging`環境に32文字以上のランダムな`PUBLIC_DATE_AUDIT_TOKEN`をsecretとして設定します。値をvars、画面、PR、ログ、レビュー資料に載せません。
- 既存の`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`ADMIN_INGEST_TOKEN`、`API_FOOTBALL_KEY`と、対象を固定するvarsも必要です。監査secret未設定／短すぎる場合はmigration前のpreflightで停止します。
- このworkflowの変更をレビューしてからPR #123のマージを判断します。マージは実環境へのmigrationとWorker展開を開始する操作です。PR #122はマージしません。

## マージ後

- マージしたSHAの`Deploy Public Worker`で3ジョブとfresh検証の成功を確認します。公開Workerの監査secretはworkflowが設定し、日程同期は同じGitHub環境secretを使います。
- 失敗時は原因を直し、同じレビュー済みSHAのworkflowを再実行します。migrationが一部適用済みなら履歴を確認して再開し、手動で履歴を消しません。後続ジョブだけを再実行して成功した前提を無視したり、旧コミットのAdmin／公開Workerを再展開したりしません。
- 公開Worker展開後の失敗・取消はD1公開読取OFFへの退避の対象です。条件は`(failure() || cancelled()) && steps.deploy.outcome == 'success'`で、展開前の失敗・取消では退避デプロイを行いません。これは旧コード・migrationの巻戻しではなく、退避が成功してもworkflowは成功に変わりません。退避用の証跡ディレクトリは公開Worker展開前に作ります。
- curlは接続5秒・1要求20秒、再試行の開始期限60秒に制限します。期限直前に開始した最後の要求は最大20秒続き得ます。取消時に退避が実行されることは実環境では未検証で、強制取消、ジョブ時間上限、runner消失、展開コマンドが完了したのにstepのsuccessが記録される前の停止では、自動退避を保証しません。GitHubの[取消処理](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)を踏まえ、未検証の展開が残り得る場合は次の手動退避を実施します。
- `fixture_schedule_repair_status`、SCHED-R3の読取SQL、保留1552141と最新previewを確認します。必要な修復は調査・証跡ハッシュ付き承認を経て行います。
- 日付をまたぐ変更2件以上の限定実行でexecutor、repair report、fresh監査を確認し、旧・新日付の一般／大会別一覧をブラウザで確認します。日程同期を先に、15分更新は結果・日付移動の検証後に有効化します。

## 自動退避が完了しない場合の手動退避

1. 自動更新を停止したまま、該当の展開と他の公開Worker展開が終了していることを確認します。取消を連打したり、未完了の展開と手動退避を並行させたりしません。展開コマンドの成否が不明ならCloudflareのversion/deployment履歴を読み、状態を確認します。
2. 対象のレビュー済みSHAをcheckoutした作業環境で、既存の管理された`CLOUDFLARE_API_TOKEN`と`CLOUDFLARE_ACCOUNT_ID`を使います。以下は公開Worker設定への書込みを伴うため、実施判断後に実行します。secretの値をコマンドやログへ貼りません。

   ```sh
   node scripts/v2/render-public-wrangler.mjs \
     --manifest config/public-worker-target.json \
     --output .tmp/public-worker/wrangler-manual-rollback.toml \
     --disable-d1-reads
   npx --yes wrangler@4 deploy --config .tmp/public-worker/wrangler-manual-rollback.toml
   node scripts/v2/inspect-cloudflare-connection.mjs
   jq -e '.publicVars | [.D1_DATE_INDEX_ENABLED, .D1_COMPETITION_DATE_INDEX_ENABLED,
     .D1_STANDINGS_ENABLED, .D1_FIXTURE_DETAIL_ENABLED] | all(. == "false")' \
     .tmp/cloudflare-connection/report.json
   worker_origin=$(jq -r '.workerOrigin' config/public-worker-target.json)
   app_origin=$(jq -r '.appOrigin' config/public-worker-target.json)
   curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
     --header "Origin: $app_origin" "$worker_origin/health"
   ```

3. version、D1公開読取4フラグがOFF、許可originでのhealthを確認し、画面の一般／大会別一覧を確認します。確認できなければ退避成功とは扱いません。migrationの履歴や修復キューを削除せず、Admin Workerを旧版に戻しません。secretが退避デプロイ後も保持されることは別途確認が必要です。
4. 原因の修正後に同じレビュー済みSHAの通常pipelineを再実行し、freshの正常・拒否検証と実データの限定検証を完了してから有効化を判断します。

## 今回の実環境読取

2026-10-08 15:08 JSTの読取専用inventory再実行（run `36508632712` / job `113175420075`）では、`jfw-football-staging`はmigration 0009までで0010–0012は未適用でした。対象10大会のfixturesは3420、publishedFixtureDetailsは575、外部キー違反とシーズン範囲外の日付は各0件です。これは展開済みの日程変更処理やD1/R2一致の検証結果ではありません。

今回の修正・テストではremote migration、Worker展開、secret設定、自動更新の有効化、API-Football呼出しは行いません。実環境への展開と限定実行は別の実施判断です。

## ローカル検証

`c34bd94`時点の全体は716件中714成功・失敗0・既存TODO 2、重点38件成功でした。DEPLOY-R1はこの対象をデプロイ順序PASS（BLOCKER 0 / MAJOR 0 / MINOR 3）と判定しました。今回、そのMINOR 3件を追加修正しています。remoteコマンドとHTTPはスタブで確認し、GitHub上での取消・lockの実際の挙動を検証したものとは扱いません。

追加修正の全体726件中724成功・失敗0・既存TODO 2、重点48件成功、添付の15ケースも期待結果と一致しました。認証が効いていないfreshは、以前の成功から失敗＋退避に変わっています。[対応と検証の詳細](deploy-review-r1-fix-20261008.md)を参照してください。

29件のYAMLと160個のbashブロックの構文、schema lock、差分の空白検査も成功しました。actionlint 1.7.12で呼出元・呼出先を検査し、既存の`queue: max`への未対応診断だけを除外して他の診断0件です（[既知の未対応](https://github.com/rhysd/actionlint/issues/657)）。[同じリポジトリの相対参照は同じコミットを使用するGitHub仕様](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)に従い、可変の`@main`参照は使いません。
