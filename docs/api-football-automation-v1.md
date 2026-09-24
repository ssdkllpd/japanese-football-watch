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

The 15-minute workflow trigger is a discovery cadence, not a promise to publish every 15 minutes. Newly discovered final fixtures may be checkpointed in R2 even when their detail is deferred; no due work publishes no fixture or standings object.

This unit does not yet replace the public request-time live provider path and does not publish basic scheduled fixture changes. Those are separate activation units because a basic date-feed response must never replace an existing rich fixture bundle. Until that merge rule and the compact live projection are implemented and reviewed, the current paths remain unchanged.

## Request budget

- Three JST dates are inspected per run: yesterday, today, and tomorrow.
- Before those charged requests, the API-Football `status` endpoint supplies the current daily balance. This endpoint does not count against the daily quota; missing or malformed status data stops discovery.
- Requests are serialized with at least 300 ms between starts.
- At most 20 complete fixture details are fetched per run. Each uses five provider requests.
- At most ten standings scopes are fetched per run.
- A run is capped at 150 provider calls including the uncharged status call, and preserves at least 100 reported daily requests.
- Missing quota headers stop executable planning; they are never treated as unlimited capacity.

## Publication order

The workflow uses one shared `d1-staging-write` concurrency group and follows this order:

1. Load durable state from R2.
2. Read the uncharged account status, discover fixtures, and create a deterministic bounded plan.
3. Verify the exact staging target, then checkpoint every discovered final fixture in R2 with no completed detail stages. A failed or deferred detail remains eligible after the one-day discovery window.
4. Fetch and validate every planned artifact; bind its identity to the D1 Admin Worker plan.
5. Before replacing any canonical R2 fixture, check that its current overrides cover every correction already stored in D1. Reconcile the provider values with those overrides and publish the canonical fixture and pointer.
6. Publish through the protected Admin Worker. After the fixtures, rebuild complete generic and competition date indexes from the D1 date rows, publish them to R2, and verify their coverage in D1. Then run `migration_verify`.
7. Mark detail stages complete and upload durable state only after the Admin Worker succeeds.

A failure after the discovery checkpoint retains the pending fixtures without marking a detail stage complete. A failed index rebuild leaves the stage pending; the next run retries publication and coverage repair. If a stored D1 correction lacks a canonical R2 override, publication stops before replacing that fixture. Direct `wrangler d1 execute` and migration application are not part of this workflow.

## Manual review sequence

1. Merge the disabled implementation.
2. Run `API-Football Automation` manually with `mode=preview`.
3. Review the artifact plan, scopes, quota, normalized manifests, and provider-missing fields.
4. Independently review the implementation and preview evidence.
5. Change `scheduledSynchronizationEnabled` to `true` in a reviewed commit.
6. Set `API_FOOTBALL_AUTOMATION_ENABLED=true` only after that commit is on the selected default branch.

Any competition/season change, schedule change, request-budget expansion, schema migration, catalog expansion, or mass re-import requires a new review. Ordinary standings and finalized-detail refreshes do not require manual approval after both activation gates are enabled.
