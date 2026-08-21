# Football Data Contract v2

Status: implementation baseline for the first general-football vertical slice.

## 1. Purpose

This contract separates the application from the legacy Japanese-tracker-shaped `data.json` model and from API-Football's raw response schema.

The contract has three boundaries:

1. **Provider input** — API-Football v3 response objects.
2. **Canonical football facts** — normalized fixture-centric records stored in R2.
3. **UI delivery DTOs** — small Worker responses such as `LiveFixtureDTO` or the canonical fixture bundle read API.

Japanese Tracking consumes canonical facts and never owns a second copy of those facts.

## 2. Identity

### General football core

API-Football provider IDs are the primary identity source for v2 Core.

| Entity | Canonical ID example |
|---|---|
| Competition | `af:competition:39` |
| Season | `af:season:39:2026` |
| Fixture | `af:fixture:123456` |
| Team | `af:team:40` |
| Player | `af:player:1942` |
| Coach | `af:coach:700` |
| Venue | `af:venue:55` |

Names are presentation data, never identity.

A provider player that is not present in the Japanese tracking registry is still accepted into Core.

### Japanese Tracking

Existing stable JFW player IDs remain provider-independent. Tracking stores a crosswalk from JFW identity to `af:player:*` where known.

This is intentionally asymmetric:

- Core identity follows the provider.
- Tracking identity survives provider migration.

## 3. Time

Canonical fixture timestamp: UTC ISO-8601.

```json
{
  "kickoffUtc": "2026-08-21T20:00:00.000Z"
}
```

Default product time zone: `Asia/Tokyo`.

Date indexes are explicitly JST:

```text
football/v2/indexes/date-jst/2026-08-22.json
```

An evening European fixture may therefore belong to the next day's Japanese home screen.

## 4. Canonical fixture bundle

One fixture is the basic immutable-ish fact and revision unit.

Example shape:

```json
{
  "contractVersion": "2.0.0",
  "fixture": {
    "id": "af:fixture:123456",
    "providerId": 123456,
    "competitionId": "af:competition:39",
    "seasonId": "af:season:39:2026",
    "kickoffUtc": "2026-08-21T20:00:00.000Z",
    "dateJst": "2026-08-22",
    "productTimeZone": "Asia/Tokyo",
    "status": {
      "short": "FT",
      "long": "Match Finished",
      "elapsed": 90
    },
    "ingestionState": "finalized",
    "teams": {
      "home": { "id": "af:team:40", "name": "Home FC" },
      "away": { "id": "af:team:50", "name": "Away FC" }
    },
    "score": {
      "goals": { "home": 2, "away": 1 },
      "halftime": { "home": 1, "away": 0 },
      "fulltime": { "home": 2, "away": 1 },
      "extratime": { "home": null, "away": null },
      "penalty": { "home": null, "away": null }
    },
    "revision": 1,
    "reconciledAt": "2026-08-21T21:00:00.000Z"
  },
  "competition": {},
  "season": {},
  "lineups": [],
  "events": [],
  "teamStats": [],
  "playerStats": [],
  "sectionStates": {},
  "overrides": {},
  "fieldIssues": {}
}
```

The first implementation is `scripts/v2/fixture-contract.js`.

## 5. Competition and Season

Season identity is scoped to a competition.

```json
{
  "competition": {
    "id": "af:competition:39",
    "providerId": 39,
    "name": "Premier League",
    "country": "England"
  },
  "season": {
    "id": "af:season:39:2026",
    "competitionId": "af:competition:39",
    "providerSeason": 2026,
    "label": "2026"
  }
}
```

There is no global `current: 2026-27` contract in v2.

## 6. Player match statistics

Core stores statistics for all provider players, not only tracked Japanese players.

```json
{
  "fixtureId": "af:fixture:123456",
  "playerId": "af:player:1942",
  "teamId": "af:team:40",
  "position": "F",
  "values": {
    "minutes": 90,
    "goals": 1,
    "assists": 0,
    "shots": 3,
    "rating": 7.8
  },
  "fieldStates": {
    "saves": { "presence": "not_applicable" }
  },
  "fieldIssues": {},
  "provenance": {
    "source": "api-football",
    "fetchedAt": "2026-08-21T21:00:00.000Z",
    "verification": "provider",
    "issues": []
  }
}
```

Explicit zero is preserved. Missing is not converted to zero.

## 7. Provenance model

Record provenance is the default because field-level provenance on every scalar would multiply storage size.

### Presence

- `present`
- `not_fetched`
- `provider_missing`
- `not_applicable`

### Verification

- `verified`
- `provider`
- `legacy_unverified`

### Issues

An array so issues can coexist:

- `stale`
- `conflict`

Field exceptions are sparse:

```json
{
  "fieldStates": {
    "tackles": { "presence": "provider_missing" },
    "saves": { "presence": "not_applicable" }
  },
  "fieldIssues": {
    "assists": ["conflict"]
  }
}
```

A missing scalar in a section known to be fetched can be interpreted as provider-missing when the endpoint contract guarantees that field. Do not invent this interpretation when the section itself is `not_fetched`.

## 8. Section states

Endpoint-level retrieval status is explicit:

```json
{
  "sectionStates": {
    "events": { "presence": "present" },
    "lineups": { "presence": "present" },
    "teamStats": { "presence": "not_fetched" },
    "playerStats": { "presence": "present" }
  }
}
```

This distinction is necessary because an empty fetched array and a never-requested endpoint are different states.

## 9. Formation facts vs layout

Canonical fixture data stores provider facts:

- `formation`
- player `grid`
- player position

It does not persist CSS x/y coordinates as football facts.

`formation-view.js` derives visual placement with this confidence chain:

1. formation + grid: `high`
2. grid-derived: `medium`
3. position-derived: `low`
4. even fallback: `none`

The UI renders `配置は推定` below high confidence.

## 10. Manual correction contract

Corrections remain human-authored Git data.

Example:

```json
{
  "path": "fixture.score.fulltime.home",
  "value": 3,
  "correctedProviderValue": 2,
  "reason": "Official record confirmed 3-1",
  "sourceUrl": "https://example.com/official",
  "verifiedAt": "2026-08-21T22:00:00Z"
}
```

Reconciliation compares current provider value `P1` with original provider value `P0` and manual value `M`:

- `P1 == P0`: manual override remains `active`.
- `P1 == M`: provider caught up; override becomes `provider_caught_up`.
- otherwise: override becomes `review_required`, adds `conflict`, and fixture becomes `needs_review`.

The third case does not silently let either provider or manual correction win.

## 11. R2 key layout

Canonical bundle:

```text
football/v2/competitions/{competitionId}/seasons/{seasonId}/fixtures/{fixtureId}.json
```

Fixture lookup pointer:

```text
football/v2/indexes/fixture/{fixtureId}.json
```

JST date index:

```text
football/v2/indexes/date-jst/{YYYY-MM-DD}.json
```

The pointer allows the Worker to resolve a fixture by `fixtureId` without making the UI know the R2 hierarchy.

## 12. Git / R2 / KV / Cache API ownership

### Git

Human-authored / reviewable assets:
- application code
- Data Contract
- tracking configuration
- JFW crosswalk
- manual corrections and evidence
- rating algorithm

### R2

Canonical machine facts:
- fixture bundles
- events / lineups / stats
- historical standings snapshots
- team / player master snapshots
- generated indexes

### KV

Optional hot indexes and cache data only. KV must never be the only copy of a fact.

### `caches.default`

Demand-driven live snapshot cache only. Default TTL: 60 seconds.

## 13. LiveFixtureDTO

The browser never consumes raw `/fixtures?live=all` JSON.

Worker projection:

```json
{
  "contractVersion": "2.0.0",
  "timeZone": "Asia/Tokyo",
  "generatedAt": "2026-08-21T22:00:00Z",
  "fixtures": [
    {
      "fixtureId": "af:fixture:123",
      "competitionId": "af:competition:39",
      "seasonId": "af:season:39:2026",
      "kickoffUtc": "2026-08-21T20:00:00.000Z",
      "dateJst": "2026-08-22",
      "status": { "short": "2H", "long": "Second Half", "elapsed": 63 },
      "home": { "teamId": "af:team:40", "name": "Home FC", "score": 2 },
      "away": { "teamId": "af:team:50", "name": "Away FC", "score": 1 }
    }
  ]
}
```

The Worker performs only this lightweight projection; full normalization remains Node / Actions work.

## 14. Worker read API

Initial routes:

```text
GET /api/v2/live
GET /api/v2/fixtures/{fixtureId}
GET /api/v2/dates/{YYYY-MM-DD}
GET /health
```

R2 is private from the browser. Worker origin checks and a soft per-isolate abuse guard are defense in depth. Production deployment should also use Cloudflare's account/zone rate limiting configuration rather than treating in-memory Worker counters as a globally consistent limiter.

## 15. Fixture lifecycle

Initial states:

```text
scheduled
live
provisional_final
finalized
needs_review
```

Live delivery is demand-driven and is not used to guarantee historical ingestion.

Separate reconciliation rule:

> Every 6 hours, inspect scheduled fixtures whose KO + 3 hours has passed and ensure a finalized R2 bundle exists.

This later reconcile job closes fixtures that nobody viewed live.

## 16. One-fixture vertical slice

Repository implementation:

```text
scripts/v2/fetch-fixture-vertical-slice.js
  -> API-Football fixtures
  -> fixtures/events
  -> fixtures/lineups
  -> fixtures/players
  -> fixtures/statistics
  -> scripts/v2/fixture-contract.js
  -> fixture.json
  -> fixture-pointer.json
  -> date-index.json

.github/workflows/v2-fixture-vertical-slice.yml
  -> merge existing JST date index
  -> publish three objects to R2

worker/index.mjs
  -> R2 historical read
  -> demand-driven live DTO projection
```

The workflow is manual for the first proof. It requires:

- `API_FOOTBALL_KEY` secret
- `CLOUDFLARE_API_TOKEN` secret
- `CLOUDFLARE_ACCOUNT_ID` secret
- `R2_BUCKET` repository variable

## 17. Vertical slice acceptance criteria

The first slice is considered proven only when all are true:

1. A real API-Football fixture is fetched without browser key exposure.
2. The normalized fixture passes `validateFixtureBundle`.
3. The bundle is published to R2 under the canonical key.
4. The fixture pointer resolves the canonical key.
5. The JST date index contains the fixture without overwriting other fixtures on that date.
6. Worker `GET /api/v2/fixtures/{fixtureId}` returns the bundle.
7. Worker `GET /api/v2/dates/{date}` returns the index.
8. Worker `GET /api/v2/live` returns only LiveFixtureDTO fields.
9. Existing Japanese tracking tests continue to pass.
10. No Core ingestion path rejects a player merely because that player is absent from the Japanese registry.

## 18. Legacy migration

`data.json` remains operational during the vertical slice.

Migration order:

1. Prove the contract with one fixture.
2. Build a generic fixture/date feed.
3. Recompute Japanese-player views from Core facts.
4. Verify current Japanese-tracker parity, including G/A and JFW Rating regression cases.
5. Stop browser-runtime overlay merging only after equivalent build-time/R2 facts are proven.
6. Retire the global `seasons.json` current-season assumption after competition-specific season routing exists.

Do not delete the working legacy tracker before parity tests exist on the v2 path.
