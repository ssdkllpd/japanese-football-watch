# Live acquisition operations

The private `jfw-football-live-acquisition` Worker schedules work; the `API-Football Live Acquisition` GitHub workflow acquires provider data and saves provisional scores and match details in the separate `jfw-football-live` D1 database. The provider credential stays in the protected GitHub environment and is absent from both Workers. The scheduler holds only the workflow-dispatch credential. The public Worker and browser read stored data and never call the provider. Existing finalized publication remains separate and takes precedence over provisional scores.

This split follows production verification: API calls succeeded from GitHub, while Workers returned provider `rateLimit` errors even at one call per minute. API-Sports documents that shared outbound IPs, including Cloudflare Workers, can hit network protection due to other users' traffic: https://www.api-football.com/news/post/how-ratelimit-works.

## Timing and scope

- A Cloudflare minute cron checks D1. The first acquisition of each JST day checks today's and tomorrow's schedules once. Every 15 minutes, a GitHub tick also refreshes the schedule inventory from the core database without spending provider requests. Otherwise idle ticks stay entirely in Cloudflare/D1.
- Each relevant fixture is checked again within two hours and within one hour of kickoff. A changed kickoff resets both confirmations. Catch-up confirmations happen on separate ticks.
- After both confirmations, live acquisition starts one hour before kickoff. One `fixtures?live=all` request covers simultaneous games and is filtered to the ten configured leagues and known eligible fixtures. Each acquisition cycle refreshes quota information first. Provider calls from the runner are paced at least one second apart.
- Thirty minutes without live data triggers a fixture schedule check. A previously observed game disappearing from live results is checked immediately for its final score. A postponement or cancellation removes that game without stopping others.
- The acquisition window ends six hours after scheduled kickoff. Snapshots older than three minutes are visibly stale. Both today's visible match list and today's non-final fixture detail refresh stored data once per minute; hidden tabs do not refresh.
- Active acquisition is dispatched at most once per minute. GitHub startup/queue latency can delay an individual update, so this is not an exact one-minute delivery guarantee. Existing queued/running jobs block further dispatches, stale trigger slots older than three minutes are discarded, and jobs have a four-minute timeout. Dispatch alone never fabricates an acquisition heartbeat.

## Provisional match details

The two-hour and one-hour schedule checks also save any available announced lineups. Within the confirmed one-hour window, `fixtures?ids=...` retrieves the available lineups, events, team statistics and player performances in groups of at most 20. Scheduled fixtures are revisited every five minutes; live fixtures every two minutes. The existing 12-request tick limit, 4,000-request daily limit and provider reserve remain unchanged. When simultaneous fixtures exceed a tick's capacity, the oldest details are selected first; delivery can take longer than the target interval.

`live_details` stores one normalized JSON row per fixture in the separate live database, with two-day retention. Score-only `live=all` responses never overwrite it. Explicit empty event arrays replace old events (including VAR reversals); omitted sections retain the last acquired section and are visibly flagged. Failed requests preserve stored data. A final-status ID recheck saves the last provisional detail while core final publication continues independently.

`GET /api/v2/fixtures/<id>` serves stored provisional details for the same fixture, league, season and clubs until a finalized core revision is available. It bypasses the old core-detail cache while checking that transition. Public reads never call the provider. Missing detail storage falls back to existing core/R2 data, and stale details are flagged after three minutes (six minutes for pre-match data). A late update is shown with its acquisition time, never as a newly fetched response.

Visible pre-match and live detail screens re-read this stored endpoint every minute, keeping the selected tab and rating mode. A failed refresh keeps the previous content with an update warning. Final publication ends detail polling. Midnight does not stop an already-live fixture's detail refresh.

## Budgets and safety

The live request budget is 4,000 per UTC day, counted conservatively including status checks and failed attempts. The provider reserve is 1,200 requests plus a 12-request operating cushion. A cached exhausted quota blocks further live calls until the UTC day changes. Existing final acquisition keeps its independent reserve.

Live D1 has a conservative 100,000 written-row daily guard measured from actual D1 metadata, with a 10,000-row operating reserve. This is separate from the 240-fixture final-publication limit. Other account D1 usage still counts toward billing.

An atomic D1 minute claim deduplicates workflow dispatches; a separate D1 lease and minute claim protect actual acquisition. Ambiguous dispatch responses are recorded before any later retry. A running/queued job is deferred. Provider redirects are rejected, fixture-ID rechecks use batches of at most 20, and incomplete quota or pagination information fails closed. The remote core adapter permits SELECT only; live batches use D1's REST batch protocol. Production tables never receive simulated fixtures.

## Deployment and rollback

1. Provision the dedicated database with acquisition and public live reads disabled. Apply only `migrations/live/*.sql`, deploy the private scheduler disabled, install its workflow token, remove its provider key, and confirm a real disabled cron heartbeat.
2. Pin its UUID and enable acquisition in `config/live-worker-target.json`, using `acquisitionMode: github`. Confirm a real dispatched GitHub acquisition and successful D1 heartbeat before enabling public reads. An enabled deployment also probes the real batch-live response once from GitHub, counting requests without publishing probe fixtures.
3. Set public `liveReadEnabled: true`. Public deployment checks the D1 source header, enabled/fresh live contract, absence of a provider credential and existing final-data routes.

Activation verification allows two transient failed ticks to recover; three distinct completed failed ticks fail activation. In-flight leases do not count as completed failures. Deployment failure automatically disables the private scheduler. Queued GitHub jobs inspect the actual deployed enable/mode switches before acquiring, so a disabled deployment cannot be bypassed by a late job. To roll back published reads, first disable public live reads, then acquisition; preserve storage-only viewer access.

## Monitoring and verification

`live_control` records real acquisition/idle heartbeat, last successful tick, status/error, latest live poll and next start. `live_dispatch_slots` records dispatch claims, acceptance/uncertainty and run IDs. `live_budget` records calls, remaining quota and billed writes. `live_provider_errors` retains at most 100 operator-only provider errors with the key redacted; the public response exposes none of these details.

The existing Automation Watchdog checks the live D1 heartbeat, enable switch and error status after public activation. Failed GitHub acquisition jobs also use the existing failed-workflow notification settings. The watchdog's existing completion triggers and GitHub schedule do not guarantee a strict notification deadline.

`node --test tests/*.test.js` checks contracts, guards, deployment verification and UI refresh. `scripts/live/test-workerd.mjs` runs actual Worker handlers, GitHub dispatch deduplication and Node acquisition against native workerd/D1 through the REST adapter, with provider responses stubbed in-process. It covers schedule changes, absent data, goals, concurrent ticks, final transitions, reserves, redirects, stale reads, queued/stale/disabled runners, read-only core access and transactional batch rollback. No external requests occur in that test.
