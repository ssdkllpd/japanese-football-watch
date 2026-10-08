# DEPLOY-R1のMINOR対応（2026-10-08）

ClaudeのDEPLOY-R1は`c34bd94`のデプロイ順序をPASS（BLOCKER 0 / MAJOR 0 / MINOR 3）と判定しました。今回はその3件を修正します。Worker、Adminの処理本体、migration SQLは変更しません。

| ID | 修正 | 検証 |
| --- | --- | --- |
| 001 | 一般／大会別のfreshへtokenなし・誤tokenを送り、4要求すべて401・no-store・CORSを要求 | 実YAMLのbashで、認証を無視する一般／大会別、tokenなしだけ許可、誤tokenだけ許可、拒否応答がキャッシュ／503のケースを拒否。添付fresh-openも失敗して退避 |
| 002 | 退避条件にcancelled()を追加。全curlへ接続5秒・要求20秒、再試行がある箇所へ開始期限60秒を設定。手動退避を記載 | 条件と全curlの静的検査、timeout相当のcurl exit 28を拒否。添付の検証失敗6ケースで退避コマンド成功。取消・時間上限の実GitHub挙動は未検証 |
| 003 | d1-staging-writeのconcurrencyをAdmin展開ジョブへ移動。workflow単位から削除し、callerへ同じgroupを重ねない | YAMLのジョブ構造、queue=max・cancel-in-progress=false、callerのlockなしを確認。GitHub上で同時実行は試していない |

誤tokenは有効tokenとは別の固定値です。偶然同じ値なら別の固定値を使い、有効tokenを連結しません。未認証応答の本文は保存せず、応答ヘッダーと拒否要求数を証跡に残します。これらが失敗すればfresh成功レポートを作りません。

取消時の自動退避は保証ではありません。強制取消、runner消失、ジョブ時間上限、展開完了がsuccessとして記録される前の停止では、退避stepが走らない可能性があります。[展開手順書](schedule-deployment-order-20261008.md)の手動退避では、自動更新・他の展開の停止を確認してから公開WorkerのD1読取をOFFで再展開し、Cloudflare設定の4フラグとhealthを読み直します。migrationや修復キュー、Adminのコードを巻き戻しません。

## 検証結果

- 外向きsocketを遮断した全体726件中724成功・失敗0・既存TODO 2。フックの外向き接続試行0。
- 重点48件すべて成功。実workflowのshellを実行し、HTTPとsecret設定はスタブ。
- 提供ZIPの`probes/run-steps.py`と`bin/curl`・`bin/npx`を変更せず15ケース再実行。fresh-openを「失敗＋退避」が期待結果として判定し、他の14件は従来の成功／失敗を維持。tokenの証跡出力0。取消の状態はこのプローブでは模擬していません。
- 29 YAML、160 bash、schema lock、差分検査成功。actionlint1.7.12では既存queueキーの未対応診断だけを除外し、他の診断0。

自己検証であり、変更後の独立レビューPASSとは扱いません。DEPLOY-R1の独立PASSは比較元c34bd94への判定です。GitHub環境のブランチ規則・承認者、取消時の実挙動、secretの実デプロイ／退避後の保持は未検証です。マージ・remote migration・Worker展開・secret設定・自動更新有効化・Cloudflare/D1/R2書込み・API-Football呼出しは行っていません。
