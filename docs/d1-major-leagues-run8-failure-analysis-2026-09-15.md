# D1 major-league staging migration Run #8 failure analysis

## Evidence identity

- Workflow run: `34914362479`
- Git commit: `030028224bce3ec5f1450a0799268dbe3434aa50`
- Branch: `fix/d1-migration-safety-r2`
- Artifact: `d1-major-leagues-staging-migration-030028224bce3ec5f1450a0799268dbe3434aa50.zip`
- Artifact SHA-256: `757f375169f54fadff9af43d0a1c15a2a8fd8c366f8cc71bff085cd4ae70aeef`
- Result: failed after 26 minutes 17 seconds in `Execute idempotent staging migration and exact scoped verification`

The downloaded artifact digest exactly matched the digest shown by GitHub Actions.

## Confirmed execution state

The pre-write partial-state gate passed as `compatible-partial`:

- expected compact fixtures: 3,420
- expected fixture details: 365
- matched fixture details before Run #8: 278
- pending fixture details before Run #8: 87
- pending fixture upgrades: 0

The execution client then recorded:

- authoritative admin requests: 564
- attempted logical requests: 357
- successful logical requests: 356
- failed logical requests: 1
- successful core publications: 10
- successful standings publications: 10
- successful fixture publications: 336
  - already published no-ops: 278
  - newly imported: 58
- failed fixture: `af:fixture:1556630`
- failure: HTTP 503 after four attempts

Therefore at least 336 of 365 fixture details have a confirmed successful response. The failed
request might or might not have committed before the 503 response, so the remaining 29 details
must be classified again from a fresh read-only D1 preflight rather than inferred.

No date-coverage request and no final `migration_verify` request ran. Public read flags remained
unchanged, and no API-Football request was made.

## Failure classification

This is not a recurrence of the previous content-hash mismatch: the corrected pre-write partial
state check passed. It is also not an ordinary deterministic payload rejection produced by the
admin Worker, because those are returned as HTTP 422 with a bounded detail message.

The exact lower-level source of the 503 cannot be proven from the Run #8 artifact. The old client
discarded the JSON `error` field, non-JSON response metadata, response-body digest, and Cloudflare
request identifier. A Cloudflare/platform transient is the leading explanation, but a fixture-
specific platform resource failure cannot be excluded. Missing admin configuration is unlikely
because 356 requests to the same deployed endpoint succeeded immediately beforehand.

## Remediation implemented for review

1. The D1 preflight now emits a schema-versioned, sorted partition of matched and pending fixture
   detail IDs.
2. The migration client validates that partition against the independently prepared authoritative
   request set and fails closed on stale, duplicate, unknown, unsorted, or incomplete partitions.
3. Only pending fixture writes are sent again. The final verification request still covers all 365
   fixture IDs.
4. Only artifacts referenced by the reduced execution plan are uploaded to R2. For a confirmed
   336/365 state this reduces fixture uploads from 365 to 29 and total uploads from 376 to 40.
5. Retryable 429/502/503/504 and transient network failures now receive six bounded attempts with
   exponential delays capped at 30 seconds.
6. Failure evidence now records bounded service error/detail fields, body size and SHA-256, body
   kind, content type, `Retry-After`, and `CF-Ray` when present. Raw non-JSON bodies and credentials
   are never written to evidence.

The next staging write must not run until an independent reviewer accepts the implementation and
its fail-closed properties.
