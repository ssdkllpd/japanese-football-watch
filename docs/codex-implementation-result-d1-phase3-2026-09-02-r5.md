# D1 Phase 3 R5 implementation result

- Date: 2026-09-02 JST
- Base: `ab304e16c3db4e3f17be33b96d2f68b416d3dbf1` (R3 + reviewed R4)
- Review input: `docs/claude-review-result-d1-phase3-2026-09-02-r4.md`
- Implementation: Codex (Chappy)
- Independent review: pending (Claude)
- Staging D1 migration: **NO — real R2 artifact probe pending**
- Production cutover: **NO**

## Scope boundary

R5 changes only the four items agreed in the R4 review:

1. validate fixture detail on the flag-OFF R2 path;
2. keep degraded delivery available when `fixture.reconciledAt` is missing or non-canonical;
3. document the four deliberately open dynamic maps;
4. run the existing regression suite.

R3-005 and the other resolved findings were not reopened. No workflow, target manifest, migration, secret, flag or Cloudflare resource was changed.

## D1P3-R4-001

The flag-OFF branch now calls `r2FixturePayload()` instead of `fixtureFromR2()` / `r2JsonObject()`. The raw unvalidated fixture response helper was removed. Normal R2, R2-not-migrated and R2-degraded fixture responses therefore share the same pointer identity checks and recursively closed generated contract.

The flag-OFF regression enumerates every fixed object path present in the generated available DTO sample. All 27 unique fixed object paths reject an injected unknown key. Dynamic maps remain open by design.

The flag-OFF response now includes `x-jfw-data-source: r2`; its JSON body remains the validated artifact without DTO rewriting.

## Degraded timestamp availability

`fixture.reconciledAt` is optional only while validating a degraded R2 response. A canonical millisecond UTC timestamp produces `lastSuccessfulAt` as before. Missing or malformed values no longer turn a D1 outage into a 503; the Worker returns the validated payload with `degraded: true` and omits `lastSuccessfulAt`.

Normal R2, archive and D1 paths keep their existing contract requirements. This exception is limited to degraded availability behavior.

## Dynamic map contract

`docs/data-contract-v2.md` and the Phase 3 implementation document now distinguish fixed DTO fields from the four public extension maps:

- `teamStats[].values`
- `playerStats[].values`
- root `overrides`
- root `fieldIssues`

Keys remain open for provider stat names or canonical field paths. Generated value constraints remain in force where the schema defines them, and D1/R2 retain the same public shape.

## Real R2 artifact acceptance

The repository and all reachable local worktrees contain no stored contract 2.0.0 or 2.1.0 R2 fixture artifact. Git history also contains no such JSON object. Therefore the R4 acceptance condition requiring existing R2 bytes is **not claimed as complete**.

`scripts/d1/probe-r2-fixture-artifacts.mjs` reduces that remaining check to one command. It requires:

- one unmodified contract 2.0.0 R2 artifact;
- one unmodified contract 2.1.0 R2 artifact;
- one unmodified 2.1.0 artifact whose root `overrides` and `fieldIssues` are both non-empty.

The probe routes all three through the actual Worker flag-OFF branch, proves D1 is not read, compares the response body to the parsed input, and emits SHA-256 evidence. Its harness is covered by a synthetic producer-generated test, but that test is explicitly not classified as the real-artifact acceptance result.

Until the three real inputs produce `verdict: PASS`, staging migration remains NO.

## Anti-failure

The R5 fixture tests were applied to the unchanged R4 implementation (`ab304e1`) and the agreed failure-focused subset was run:

```text
R4 implementation + R5 tests
  33 tests / 0 pass / 33 fail

R5 implementation + R5 tests
  57 tests / 57 pass / 0 fail
```

The R4 failures include both missing/malformed degraded timestamps (`503`, expected `200`) and every flag-OFF unknown-field injection (`200`, expected `500`). The tests therefore detect the two R5 behavior changes rather than merely documenting them.

## Local verification

```text
node --check worker/index.mjs                              PASS
node --check scripts/d1/probe-r2-fixture-artifacts.mjs    PASS
node --test tests/d1-fixture-worker.test.js               PASS
node --test tests/d1-r2-fixture-artifact-probe.test.js     PASS
node --test tests/*.test.js                                408 tests / 406 pass / 0 fail / 2 todo
git diff --check                                           PASS
```

The only TODOs are the two pre-existing backfill idempotency cases.

## Independent review focus

The remaining review can be limited to:

1. confirm flag OFF reaches `r2FixturePayload()` and the old raw fixture helper is absent;
2. confirm degraded timestamp omission does not weaken fixed-field closure beyond `fixture.reconciledAt` on the degraded path;
3. run the supplied real-artifact probe with the three R2 files and record its SHA-256 report;
4. run the full regression suite.

Do not reopen R3-005 or repeat the R4 38-location probe from scratch unless the generated 27-path enumerator or the real-artifact probe fails.
