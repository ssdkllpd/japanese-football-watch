# D1 Phase 3 R4 implementation result

- Date: 2026-09-02 JST
- Base: `c9b2a2459622f51a30689846602379548b99aee6` + `d1-phase3-r3-fixes.patch`
- Specification: `d1-phase3-r4-fix-specification.md`
- Implementation: Codex (Chappy)
- Independent review: pending (Claude)
- Staging D1 migration: **NO**
- Production cutover: **NO**

## Decisions applied

1. The reviewed target manifest is repository-managed at `config/d1-targets.json`.
2. Fixture degraded responses use `fixture.reconciledAt` as `lastSuccessfulAt`.

## R3-005

`verify-d1-target.mjs` compares the runner-resolved D1 database name/UUID, admin Worker name, R2 bucket name and admin endpoint origin with the repository manifest by exact equality. Naming conventions and substring checks are not used.

The same proof runs before the first relevant write in all six workflows:

- staging provision
- staging bootstrap
- staging data migrate
- standings mirror
- fixture mirror
- date mirror

SYUUHEI confirmed the staging D1 name/UUID, R2 bucket and Workers account subdomain in the Cloudflare Dashboard. The manifest fixes those externally confirmed values together with the admin Worker name that staging provision will deploy. Its origin is deterministic from the reviewed Worker name and account subdomain: `https://jfw-football-admin-ingest-staging.ssdkllpd.workers.dev`. No identity is inferred from a test fixture or a naming-only acceptance rule. The committed-manifest test independently locks all five values, and every staging write still fails closed if a resolved value differs.

## R3-006

The fixture detail schema is generated from the actual `buildAvailableBundle()` and `buildUnavailableBundle()` output shapes. The Worker recursively closes fixed object keys while preserving deliberately dynamic maps such as stats values, field states, overrides and field issues.

The generator initially exposed an additional bug during implementation: merging an unavailable bundle's empty arrays replaced the available bundle's element schema with `any`. Nested tests for lineups/events/stats caught it. Empty arrays now contribute no item-shape evidence, so the populated available bundle defines those element contracts.

Contract 2.0.0 continues to allow only the historical absence of root `detailAvailability`; its nested shape remains closed.

## R3-007

Fixture bundles do not have root `generatedAt`. A degraded response now sets `lastSuccessfulAt` from the canonical `fixture.reconciledAt`. The timestamp means the time that exact fixture revision was last reconciled and published; this differs from the date/standings collection-generation timestamp and is documented in the contract.

## Test results

```text
baseline c9b2a24:
343 tests / 341 pass / 0 fail / 2 todo

R3 + R4:
372 tests / 370 pass / 0 fail / 2 todo
```

R4 adds 17 tests relative to the independently reviewed R3 patch.

Baseline anti-failure:

| Regression test | Baseline result |
| --- | --- |
| R2-not-migrated unknown root | fail |
| R2-not-migrated unknown nested | fail |
| degraded R2 unknown root | fail |
| degraded R2 unknown nested | fail |
| 12 fixed nested DTO injection cases | 13 tests / 0 pass / 13 fail |
| fixture degraded `lastSuccessfulAt` | fail |
| all six workflow target proofs | fail |

The generated-schema freshness test passes with baseline DTO builders and is classified as a documentation/generation test, not an anti-failure test.

Additional checks:

- JavaScript / MJS syntax: pass
- generated contract freshness (`cmp`): pass
- workflow YAML parse: pass
- `git diff --check`: pass
- Cloudflare D1/R2 identities: supplied and confirmed by SYUUHEI
- admin Worker deployments, GitHub variables/secrets and flags: unchanged

## Independent review focus

1. Confirm the manifest has no sentinel and locks the externally confirmed D1/R2 identities plus the planned admin Worker target.
2. Re-run normal R2 and degraded R2 injections using root-valid payloads.
3. Inject unknown fields into every fixed array element, especially lineups/events/teamStats/playerStats.
4. Confirm dynamic maps accept legitimate provider/stat field names but reject malformed structured values where a value schema exists.
5. Confirm exact valid target values are accepted and each identity/origin mismatch fails before a write.
6. Confirm the Worker origin is exactly derived from `jfw-football-admin-ingest-staging` and the reviewed `ssdkllpd` account subdomain; do not deploy the Worker during review.
