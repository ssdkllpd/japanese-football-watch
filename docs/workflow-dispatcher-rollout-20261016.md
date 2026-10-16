# Cloudflare workflow dispatch rollout

Public reads must never call API-Football. The October 16 live pause removes that path while saved D1/R2 data remains available. Full live ingestion is a separate implementation: scheduled acquisition writes a D1 live table, and public reads only that stored data.

## Prepared configuration

The October 16 cutover selects `triggerSource: cloudflare` in `config/workflow-dispatcher.json` and removes both legacy GitHub cron blocks. The registered credential is `WORKFLOW_DISPATCH_TOKEN`. Configuration alone is not completion evidence: the deployment workflow must verify real cron records and successful synchronization jobs on the exact cutover commit.

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
