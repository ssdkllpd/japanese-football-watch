# Manual final-fixture backfill

`API-Football Manual Backfill` is a separately gated, manual workflow for the ten
reviewed 2026 competition seasons. It leaves scheduled synchronization disabled.

The workflow reads the published fixture IDs in the exact staging D1 target and
queries each of the ten full season fixture lists. It selects final `FT`, `AET`,
or `PEN` fixtures with kickoff on or before the current JST date and at least
three hours elapsed since kickoff. An existing published detail is skipped;
the archival snapshot and migrated 365 details are not fetched again. `NS`,
live, postponed, and other nonfinal statuses are counted but not published.
The workflow prints the count and IDs still missing from D1.

For each run it plans at most 20 new fixture details, five API requests each,
and up to ten standings. API-Football's daily balance retains a reserve of 100;
the plan is capped at 150 requests. D1 enforces a shared 20 distinct fixtures
per UTC day across manual and automated writers. Running again on the same day
does not exceed that cap. After successful publication, D1 becomes the resume
checkpoint; a later run recomputes the remaining difference. Partial failure
does not mark unpublished fixtures complete. A pending R2 checkpoint allows
the next execute run to repair date indexes for any fixtures that reached D1
before a failure. The workflow uses the existing
correction guard, canonical R2 reconciliation, Admin Worker, and date-index
rebuild used by automation.

1. Review and merge this workflow and planner.
2. In GitHub Actions, select **API-Football Manual Backfill**, choose `preview`,
   and inspect the artifact `plan.json` for `missingFixtureCount`,
   `detailFetches`, `remainingAfterBatch`, and provider quota. Preview performs
   API reads and artifact validation without R2 or D1 writes.
3. Run it again with `mode=execute` and exact confirmation
   `RUN API-FOOTBALL BACKFILL`. Check `admin-report.json` and that the run
   succeeds. Each execute run fetches its own current D1 and provider inventory.
4. Repeat at most once per UTC day while `remainingAfterBatch` is positive and
   the D1 publication limit is exhausted. A final preview with
   `missingFixtureCount=0` confirms the eligible finished matches are present.

Matches still live, not yet confirmed final by the provider, or within three
hours of kickoff remain outside this backfill. The separate automation's
correction stages and future scheduled discovery still require their own
activation review.
