# Live acquisition operations

The private `jfw-football-live-acquisition` Worker is the only live component that receives the provider credential. A minute cron stores provisional scores in the separate `jfw-football-live` D1 database. The public Worker and browser read stored data; neither has a provider credential or calls the provider. Final publication remains in the existing database and takes precedence over provisional scores.

## Timing and scope

- The first enabled tick of each JST day checks today's and tomorrow's schedules once. The existing core schedule is also read every 15 minutes without provider requests.
- Each relevant fixture is checked again within two hours and within one hour of kickoff. A changed kickoff resets both confirmations. Catch-up confirmations happen on separate ticks.
- After both confirmations, acquisition starts one hour before kickoff. One `fixtures?live=all` request covers simultaneous games; it is filtered to the ten configured leagues and known eligible fixtures. Polling runs once per minute while a fixture is eligible, with a fresh quota check before each acquisition cycle.
- Thirty minutes without live data triggers a fixture schedule check. A previously observed game disappearing from live results is checked immediately for its final score. A postponement or cancellation removes that game without stopping other games.
- The acquisition window ends six hours after the scheduled kickoff. This bounds unusual suspended games and provider costs. Snapshots older than three minutes are visibly stale; old scores are never presented as fresh merely because the scheduler is alive.
- Browsers refresh today's visible match list and today's non-final fixture detail once per minute. The live endpoint returns only stored snapshots and monitoring metadata. Hidden tabs do not refresh.

## Budgets and safety

The live request budget is 4,000 per UTC day, counted conservatively including quota checks and failed attempts. The provider reserve is 1,200 requests; acquisition uses a further 12-request cushion, matching the maximum requests allowed in one tick. A cached exhausted quota blocks further live calls until the UTC day changes. Existing final acquisition keeps its independent reserve.

The live database has a conservative 100,000 written-row daily guard, measured from D1 result metadata with a 10,000-row operating reserve. This is separate from the 240-fixture final-publication limit. The account's other D1 use still counts toward account billing.

An atomic D1 lease and minute claim prevent duplicate acquisition. Provider redirects are rejected, fixture-ID rechecks use batches of at most 20, incomplete quota or pagination information fails closed, and the public reader retains the last snapshot with an explicit stale/paused notice. Production tables are never populated with simulated fixtures.

## Deployment and rollback

1. Deploy with `databaseId: null`, acquisition disabled and public live reads disabled. The deployment creates the dedicated database, applies only the dedicated `migrations/live/*.sql`, installs the key on the private Worker, and waits for a real disabled cron heartbeat. The database UUID is logged and saved as an Actions artifact.
2. Pin that UUID in `config/live-worker-target.json` and enable acquisition. Confirm a real cron heartbeat and successful provider acquisition before enabling reads. The enabled deployment also probes the real `fixtures?live=all` response once, counting its requests in the live budget without publishing probe fixtures.
3. Set `liveReadEnabled: true` in `config/public-worker-target.json`. The public deployment checks the D1 source header, enabled/fresh contract and existing final-data routes. No provider credential is installed on the public Worker.

Activation verification allows up to two transient failed cron ticks to recover; three distinct completed failed ticks fail activation. In-flight leases do not count as completed failures. An acquisition deployment failure automatically deploys the private Worker disabled. To roll back a published reader, first set public `liveReadEnabled` false, then disable acquisition. Do not restore viewer-driven provider requests.

## Monitoring and verification

`live_control` records cron heartbeat, successful tick, status/error, latest live poll and next acquisition start. `live_budget` records provider requests, remaining quota and actual written-row metadata. `live_provider_errors` retains at most 100 operator-only provider errors, with the API key redacted; the public endpoint never exposes these details. The deployment verifier requires an actual post-deployment cron tick rather than inserting a synthetic heartbeat.

The existing Automation Watchdog checks the live D1 heartbeat, enable switch and error status once both acquisition and public reads are enabled. Its existing workflow-completion triggers and GitHub schedule remain the notification mechanism; a strict delivery deadline is not guaranteed by GitHub's scheduled trigger. Budget pauses are reported as warnings. Inspect the Live Acquisition deployment and Worker logs for failures; a test email alone does not prove every production failure path.

`node --test tests/*.test.js` covers contracts, guards and UI refresh. `scripts/live/test-workerd.mjs` runs the actual Worker and public reader on native workerd/D1 with provider responses stubbed in-process. It exercises disabled/idle cycles, confirmations, isolated rescheduling, absence checks, live scores, concurrent ticks, final transitions, reserve exhaustion, redirects and stale reads. It also invokes the default scheduled handler with a real third execution-context argument.
