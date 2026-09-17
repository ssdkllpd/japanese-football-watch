# API-Football automation v1

## Status

The workflow is implemented but deliberately inactive.

- `config/api-football-automation.json` has `scheduledSynchronizationEnabled: false`.
- Scheduled runs also require the repository variable `API_FOOTBALL_AUTOMATION_ENABLED=true`.
- A manual `execute` run additionally requires the exact confirmation `RUN API-FOOTBALL AUTOMATION`.
- A manual `preview` may fetch and validate artifacts, but every R2, D1, and state-write step is gated to `execute`.

Do not enable either scheduled switch until the implementation and a preview artifact have passed independent review.

## First activation unit

This unit automates two existing, already reviewed data paths for the ten configured 2026 competitions:

1. Standings are refreshed at most once per competition every six hours.
2. A fixture that API-Football reports as `FT`, `AET`, or `PEN` becomes eligible three hours after kickoff. Its complete detail is fetched at the initial stage and rechecked 6, 24, and 72 hours later for provider corrections.

The 15-minute workflow trigger is a discovery cadence, not a promise to write every 15 minutes. No due work produces no R2 or D1 write.

This unit does not yet replace the public request-time live provider path and does not publish basic scheduled fixture changes. Those are separate activation units because a basic date-feed response must never replace an existing rich fixture bundle. Until that merge rule and the compact live projection are implemented and reviewed, the current paths remain unchanged.

## Request budget

- Three JST dates are inspected per run: yesterday, today, and tomorrow.
- Requests are serialized with at least 300 ms between starts.
- At most 20 complete fixture details are fetched per run. Each uses five provider requests.
- At most ten standings scopes are fetched per run.
- A run is capped at 150 provider requests and preserves at least 100 reported daily requests.
- Missing quota headers stop executable planning; they are never treated as unlimited capacity.

## Publication order

The workflow uses one shared `d1-staging-write` concurrency group and follows this order:

1. Load durable state from R2.
2. Discover and create a deterministic bounded plan.
3. Fetch and validate every planned artifact without publishing anything.
4. Bind artifact identities to the D1 Admin Worker plan.
5. Verify the exact staging target.
6. Reconcile fixture revisions and publish canonical R2 objects.
7. Publish through the protected Admin Worker, including `migration_verify`.
8. Advance and upload durable automation state only after the Admin Worker succeeds.

A failure before step 6 performs no data write. A failure during or after R2 publication leaves durable state unchanged, so the same work is retried. Fixture revision reconciliation and standings keys make that retry idempotent. Direct `wrangler d1 execute` and migration application are not part of this workflow.

## Manual review sequence

1. Merge the disabled implementation.
2. Run `API-Football Automation` manually with `mode=preview`.
3. Review the artifact plan, scopes, quota, normalized manifests, and provider-missing fields.
4. Independently review the implementation and preview evidence.
5. Change `scheduledSynchronizationEnabled` to `true` in a reviewed commit.
6. Set `API_FOOTBALL_AUTOMATION_ENABLED=true` only after that commit is on the selected default branch.

Any competition/season change, schedule change, request-budget expansion, schema migration, catalog expansion, or mass re-import requires a new review. Ordinary standings and finalized-detail refreshes do not require manual approval after both activation gates are enabled.
