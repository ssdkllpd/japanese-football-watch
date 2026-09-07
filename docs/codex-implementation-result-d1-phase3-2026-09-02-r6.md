# D1 Phase 3 R6 implementation result

## Scope

This change addresses only `D1P3-R5-001` from the independent R5 review. It does not change Worker behavior, migrations, workflows, manifests, secrets, Cloudflare resources, or feature flags.

## Change

`scripts/d1/probe-r2-fixture-artifacts.mjs` now treats `--contract-2.0` as optional.

- `--contract-2.1` and `--corrections` remain required.
- When a real contract 2.0.0 R2 artifact exists, passing `--contract-2.0` runs the same version, closed-contract, fixture-identity, flag-OFF, D1-bypass, semantic-equality, and SHA-256 checks as before.
- When `--contract-2.0` is omitted, no synthetic historical artifact is created or requested.
- The report explicitly records `contractVersions["2.0.0"]` as `status: "not_provided"` and `verified: false`, with a note that the version was not verified.
- `artifacts` contains only artifacts that were actually supplied and verified.

The operating example in `docs/d1-phase3-core-read-implementation-v1.0.md` now shows the 2.1.0-only first-population case and a separate optional 2.0.0 invocation.

## Verification

```text
node --check scripts/d1/probe-r2-fixture-artifacts.mjs
PASS

node --test tests/d1-r2-fixture-artifact-probe.test.js
2 tests / 2 pass / 0 fail
```

The focused tests cover both cases:

1. a real 2.0.0 input is supplied and recorded as verified;
2. no 2.0.0 input is supplied and the report records `not_provided` / `verified: false` while the two required 2.1.0 checks pass.

The full suite was also attempted on the available Windows host. It reported `409 tests / 398 pass / 9 fail / 2 todo`. All nine failures reproduce on the unchanged R5 baseline on this host and are outside the changed files; they are caused by Windows path separators, generated-file line endings, or SQLite temporary-directory cleanup permissions. The authoritative Linux full-suite rerun remains a review/CI step and is not claimed as completed here.

## Safety

No R2 write, delete, or mutation was performed. No Cloudflare resource, deployment, secret, workflow setting, or feature flag was changed. Nothing was pushed or merged.
