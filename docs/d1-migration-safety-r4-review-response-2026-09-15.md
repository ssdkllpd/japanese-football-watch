# D1 migration safety R4 review response

Date: 2026-09-15

This change set responds to the independent R3 verdict `CHANGES_REQUIRED`
(`BLOCKER 0 / MAJOR 2 / MINOR 5`). It does not authorize or perform another
staging migration.

## Corrections

1. The public-read guard now uses `grep`, removing the workflow's dependency on
   `rg` in both the major-league migration and staging provision workflows.
2. The Time Travel bookmark remains before the first D1 write, but the partial
   fixture-state read and resume-plan construction now occur only after
   `d1 migrations apply` and exact migration-inventory verification.
3. All seven staging write workflows use the shared `d1-staging-write`
   concurrency group with `cancel-in-progress: false`.
4. The final major-league `migration_verify` request declares the expected
   `revisionNo` and normalized `contentSha256` for all 365 fixture details. The
   admin Worker reads the published revision from D1 and rejects missing,
   revision-drifted, or content-drifted rows.
5. Resume-plan count checks are derived from the authoritative plan minus the
   independently matched fixture count, rather than from the reduced arrays'
   own reported lengths.
6. Failure responses no longer copy `body.report` into evidence. They retain
   only byte count, SHA-256, and bounded schema/operation labels.
7. Retry handling accepts both numeric and HTTP-date `Retry-After` values, keeps
   the 30-second delay cap, and enforces a 60-minute client execution budget
   inside the 90-minute workflow timeout.
8. Resume-state objects reject unknown top-level fields.

## Independent constraints after R4

- Resume selection compares the post-migration D1 rows with expectations
  derived from the reviewed prepared snapshot.
- The final verification is independent of resume selection: it queries the
  final D1 published revisions and compares every declared fixture's revision
  number and normalized content hash.
- The final verification scope is not reduced when fixture writes are skipped.
  It remains all 365 reviewed fixture details.

## Verification

- Migration-focused tests cover workflow ordering, shared concurrency, request
  allow-lists, resume partitions, count reduction, HTTP-date retries, execution
  budget exhaustion, bounded failure evidence, revision/hash drift, and the
  365-fixture request-size bound.
- The complete test suite and D1 schema lock must pass before an R4 review
  bundle is submitted.
- No Cloudflare D1, R2, API-Football, public Worker, or production write is part
  of this correction step.

## Remaining release gate

An independent reviewer must return `PASS` with no BLOCKER or MAJOR findings.
The reviewed commit must then be present on GitHub and selected explicitly in
`workflow_dispatch`. Until both conditions are true, staging rerun authorization
remains `NO`.
