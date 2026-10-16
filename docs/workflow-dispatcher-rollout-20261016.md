# Cloudflare workflow dispatch rollout

Public reads must never call API-Football. The October 16 live pause removes that path while saved D1/R2 data remains available. Full live ingestion is a separate implementation: scheduled acquisition writes a D1 live table, and public reads only that stored data.

## Current activation state

Cloudflare dispatch is active after PR #138 (`1fb6f85`). The production runtime rejected `redirect: error`; PR #138 changed the Worker to `redirect: manual` and added a real workerd/native-fetch regression. The initial activation had disabled Cloudflare after verification timed out while the GitHub timers were already removed. Acquisition was not restored promptly during that investigation; this was an operational gap, not a token failure.

Successful cron evidence: automation run `38859841167` completed at 15:13 JST, schedule run `38859847149` completed at 15:14 JST, and the following 15:15 automation slot `38860217187` also succeeded. Deployment verification `38859724628` bound both successful synchronization jobs to the deployed epoch and exact commit. Slot labels (15:00 and 14:37) describe the caught-up slot, not the actual execution time. Viewer-triggered API-Football calls remain disabled.

## Prepared configuration

The prepared Cloudflare cutover selects `triggerSource: cloudflare` in `config/workflow-dispatcher.json` and removes both legacy GitHub cron blocks. It is not active while the rollback policy selects GitHub. The registered credential is `WORKFLOW_DISPATCH_TOKEN`. Configuration alone is not completion evidence: the deployment workflow must verify real cron records and successful synchronization jobs on the exact cutover commit.

The separate Worker only calls two fixed GitHub workflows on `main`. Every-minute Cloudflare cron checks the existing fifteen-minute automation slots and UTC 01:37/05:37/09:37/13:37/17:37/21:37 schedule slots. Only the latest slot for each workflow is eligible: automation catches up within fourteen minutes; schedule synchronization catches up within its four-hour slot, including once immediately after cutover. Older slots are never replayed. The Worker defers while the same workflow is queued or running and uses conditional R2 creation to claim each slot once across isolates within a deployment. Each deployment has a new epoch so verification cannot reuse an earlier deployment's success; activation may recheck the two current slots once. Existing Actions processing, R2 audit snapshots, protected writes, forty automatic fixtures/day, and the global 240-publication ceiling remain in place. External invocations respect the existing repository enable switches.

The Worker has no provider key and no D1 binding. Its R2 binding stores only dispatch records under `automation/workflow-dispatch/v1/<deployment-epoch>/`. Its HTTP entry point always rejects requests; it exposes no dispatch endpoint.

## Credential and activation

1. Create a fine-grained GitHub token restricted to `ssdkllpd/japanese-football-watch`, with repository **Actions: read and write**. Add it as environment secret `WORKFLOW_DISPATCH_TOKEN` in `d1-staging`. Do not paste the token into chat. Actions write is GitHub's required permission and also allows other Actions operations; it is not a dispatch-only permission. The Worker restricts its own use to the two fixed workflows. Set an expiry and arrange renewal.
2. Before switching, validate both repository enable switches and direct manual dispatch of both workflows. Verify the existing deployment workflow's credential readiness report. This preparation does not prove write permission merely because a token exists.
3. In one reviewed cutover, change `triggerSource` to `cloudflare`, remove the two legacy `on.schedule` blocks, and update the tests that assert those legacy schedules. The renderer rejects an enabled configuration if either legacy cron remains. The deploy workflow checks credential availability and active workflows, deploys initially with dispatch disabled, installs the credential, then enables dispatch.
4. The deployment verification reads real R2 `accepted` records and GitHub run/job metadata. It requires both workflows to have successful, executed `synchronize` jobs, exact `main` commit identity, and a Cloudflare slot in their run titles. It saves `.tmp/dispatcher/verification.json` as a workflow artifact. Verification only reads R2/GitHub; it cannot create a dispatch record or start a workflow itself. Allow up to fifteen minutes for initial Cloudflare cron propagation. Verify subsequent normal slots too. Acceptance alone does not prove that a job started or completed.
5. If activation or verification fails after Worker bootstrap, the deployment workflow disables dispatch before exiting. Restore `triggerSource: github` and the original cron blocks in a rollback commit after confirming the Worker is disabled, to prevent duplicate acquisition. A disabled policy alone does not automatically undeploy an already-enabled Worker.

GitHub runners and the shared D1 write queue can still delay processing. This architecture removes reliance on GitHub's schedule event; it cannot guarantee completion exactly every fifteen minutes. A recorded `rejected`, `uncertain`, or interrupted `attempting` slot requires inspection. GitHub has no dispatch idempotency key, so an ambiguous POST is not blindly retried; the next normal slot continues. Four-hour schedule dispatch failures need particular attention. Do not delete a claim until checking whether a matching Actions run was created.

The daily estimate remains 588 provider data requests at the reviewed workload (288 discovery + 200 final-detail + 40 standings + 60 schedules), not a measured daily total or hard maximum. Retried acquisition, manual execution, and future live ingestion are additional. The current pause eliminates viewer-triggered provider consumption. A future live budget reserve must be enforced by the scheduled acquisition process.

## References

- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/

## Independent health monitoring

`Automation Watchdog` uses a GitHub schedule at minutes 03/08/.../58, completion events from the two acquisition workflows and dispatcher deployment, and manual execution. The acquisition-health job uses the automatically issued, read-only `GITHUB_TOKEN` and has no `d1-staging` environment, Cloudflare credential, or dispatch PAT dependency. The separate platform job inspects credentials and actual Cloudflare settings; its failure does not prevent the independent heartbeat job from running.

Alarms fail the Actions job and record the cause in the job summary and retained JSON artifact:

- No successful, executed Cloudflare `synchronize` job for 30 minutes (automation), or 270 minutes (four-hour schedule plus 30-minute grace).
- Any queued/running/waiting/pending/requested run that remains unfinished for 90 minutes from creation. It is reported, never automatically cancelled during a possible write.
- A failed acquisition or dispatcher deployment observed by a completion event, even if the last acquisition heartbeat is still fresh.
- Dispatch authentication failure, token expiry within seven days, missing token binding, disabled deployed dispatch, or missing every-minute cron.

The platform report records only the expiry timestamp obtained from GitHub's `GitHub-Authentication-Token-Expiration` response header, never the token. If GitHub omits this metadata, set repository variable `WORKFLOW_DISPATCH_TOKEN_EXPIRES_AT` to the expiry timestamp; an unknown expiry is explicitly reported as a warning. This check validates read access and expiry; the existing deployment probe validates dispatch write permission.

**Notification delivery must be configured by the account owner:** GitHub Settings → Notifications → System → Actions → On GitHub and/or Email → Only notify for failed workflows. The repository contains no email addresses, external webhook, issue spam, or additional notification credential. A failed watchdog run is tested detection evidence, not proof that a person received email. See https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications .

GitHub schedule events can be delayed or dropped and can be disabled after 60 days of repository inactivity. Completion events provide another trigger while acquisition is running, but are not a substitute when all acquisition stops. This watchdog therefore does not promise detection exactly at minute 30, nor cover a total GitHub Actions outage or a disabled watchdog itself. Stronger availability requires an external uptime/alerting service with a separately verified delivery destination.

## Review integration checks and credential separation

`Verify Automation Review Findings` is a one-off/manual workflow, not another acquisition timer. It reads the stored fixture inventory around the October 16 outage without API-Football calls, and tests sixteen simultaneous conditional creates against the real R2 bucket through an explicitly remote binding. Exactly one must succeed, fifteen must return null, and all eight later attempts must return null without changing the winner. A random key under `automation/verification/r2-conditional/` is deleted after the check; production dispatch records are never touched.

The public read Worker no longer receives `API_FOOTBALL_KEY` during deployment. Its old provider secret is deleted if present, and absence is verified before public endpoint checks. Acquisition secrets stay with the scheduled acquisition workflows. Future live ingestion belongs in a separate acquisition Worker with its own provider credential; public reads continue to read stored D1 data only.

## Future live cutovers

Verify the new acquisition process against an isolated validation output while the old process is still available. Stop the old process in a separate change only after real execution, storage, and read-back verification pass. Keep the rollback path available and monitor the transition. The simultaneous removal/activation used in the October 16 scheduler cutover must not be reused for live ingestion. Current deployment failure cleanup disables Cloudflare; it does **not** automatically restore the old GitHub timers. Until an automated recovery mechanism exists, restoring the old timers is an explicit operational action and must be completed promptly instead of leaving acquisition disabled while investigating.
