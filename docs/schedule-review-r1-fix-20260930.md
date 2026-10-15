# Schedule review R1 implementation candidate — 2026-09-30

Baseline: main `7ddc2d8198fe211ee4bc05e9095539655b15adc1`; proposed audit PR #122 `6f50c48de1f842269c5e56c97542fab035d3a70c`. Scheduled bounded catch-up was paused separately on main at `4fcf96d61c84450e9e13bdbe51fae1e67283008e`. This branch is a candidate for independent re-review, not an enablement verdict.

| Finding | Candidate response | Evidence / remaining limit |
|---|---|---|
| 001 | Repair accepts a valid published destination; fixture publication drains its pending repair first | SQLite + real Admin publish path tests; live backlog unknown |
| 002 | Conditional reservation and update share one transaction; verify both change counts | Publication injected before batch leaves no pending |
| 003 | Active staging writers use queue max | GitHub documented maximum 100 waiting jobs; real queue not exercised |
| 004 | Normal mode accepts 241+ changes and processes 20; kickoff priority | 241-change CLI stub test and five nearer fixtures selected |
| 005 | CANC/ABD/AWD/WO/SUSP/INT propagate as unpublished headers | Scripted provider transitions plus Admin terminal-state regression |
| 006 | D1 date snapshot supplies previousDateJst; per-fixture publication isolation | Result crosses JST date and converges; a missing result object does not block another |
| 007 | Kickoff is mutable, while ID/league/season remain identity | Retained final kickoff correction test |
| 008 | Replace ID-only audit with full before/after header, affected R2 and public samples | R2 stale kickoff/status, unselected mutation and missing evidence fail; outside-season fixture passes. Earlier rollout's full baseline is not available here |
| 009 | Missing provider IDs are quarantined and reported; unrelated changes continue | Explicit missing ID and unrelated update test; no automatic ID deletion/replacement |
| 010 | One repair slot reserved transactionally; unique repair token | Concurrent-update test; migration 0010 preserves legacy checkpoints |
| 011 | Accept valid second-only UTC old timestamps; normalize newly stored timestamps | Real SQLite/Admin regression |
| 012 | Six full-season scans per day behind the existing gate | Four-hour checking, not a guarantee against immediate pre-kickoff changes |
| 013 | Postponed/TBD entries stay under upcoming on the club screen | Existing UI suite passes; dedicated undated listing remains outside scope |
| 014 | Add D1 read-volume guard and guard the 15-minute path | R2/Workers/storage billing and analytics lag remain outside the guard |
| 015 | Run summary exposes held reasons and stored/provider differences; recovery runbook | Published-detail holds still require explicit reconciliation. 1552141 is not declared resolved |
| 016 | Remove 3000-row minimum; scan only configured scopes from full inventory | Complete 2990-row fixture test. 2026 scope remains deliberately locked |

Independent expectations use literal inputs and JST offset arithmetic in the regression harness adapted from the supplied Claude reproduction. Tests were adjusted explicitly where the new path requires a D1 date snapshot or changes quarantine behavior. The original report/repro should be retained by the reviewer for comparison; passing modified regressions is not itself an independent verdict.

## Local validation

- Full suite: 641 tests, 639 pass, 0 fail, 2 existing TODO. Node 24 local execution; GitHub CI remains Node 22 and has not been observed for this candidate yet.
- Network blocked for the complete local test run; real SQLite and in-memory R2 with injected failures are used for Admin regressions.
- 29 workflow YAML files parsed; all 153 embedded shell blocks passed `bash -n`; `git diff --check` passed.
- Normal fixture preflight reserves one additional D1 query for the pending-repair check. Recovery additionally performs date-index repair reads/writes; its live query cost and paid runtime limits remain part of re-review and bounded live validation.
- No live D1/R2 inventory, historical held fixture 1552141 reconciliation, browser UI audit, migration 0010 or deployment is claimed by these tests.

## Re-review focus

- Atomic reservation/update and token-specific checkpoint deletion, including legacy pending rows and result publication after another date change.
- R2 fault recovery and per-fixture partial success: verify only completed identities advance durable state; quarantine must be visible and retried.
- New audit must fail on missing or corrupted evidence; unchanged and held rows must be checked against the actual pre-write inventory. Its expected update plan still comes from the planner, so provider semantic correctness requires independently scripted cases or separate raw-provider inspection.
- No execution gates are enabled, no Cloudflare migration or Worker deployment has been performed, and no provider request was made during local tests. The only direct main modification in this round pauses catch-up.
- After merge, provisioning, live SQL checks, fresh preview, one bounded execute with audit and browser verification remain required. PR #122's push-triggered audit must not be merged unchanged.

## Documentation sources

- GitHub concurrency queue: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
- D1 metrics/rowsRead: https://developers.cloudflare.com/d1/observability/metrics-analytics/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
