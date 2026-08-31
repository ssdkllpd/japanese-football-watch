# Football Data Contract v2

Status: implementation baseline for the first general-football vertical slice.

## 1. Purpose

This contract separates the application from the legacy Japanese-tracker-shaped `data.json` model and from API-Football's raw response schema.

The contract has three boundaries:

1. **Provider input** — API-Football v3 response objects.
2. **Canonical football facts** — normalized fixture-centric records。D1/R2移行後の構造化factsの正本はD1とし、R2はraw・監査snapshot・短期LIVE projection・古いdetail archiveを所有する。
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

### Contract 2.1 detail availability

The D1/R2 read-path migration introduces one backward-compatible top-level field and therefore advances the fixture bundle contract to `2.1.0`:

```json
{
  "contractVersion": "2.1.0",
  "detailAvailability": "available"
}
```

`detailAvailability` is optional while 2.0.0 artifacts remain readable. Its values are:

- `available`: the response includes the detail represented by `sectionStates`.
- `unavailable`: the fixture exists and compact score/status facts are available, but no verified hot detail or archive pointer can be read. Detail sections must be `not_fetched`.

The 2.0.0 -> 2.1.0 upcaster supplies `detailAvailability: "available"` because every valid 2.0.0 bundle was produced as a complete fixture artifact. Before the D1 endpoint is enabled, `CONTRACT_VERSION`, `normalizeFixtureBundle`, `validateFixtureBundle`, Worker DTO builders and their tests must move to 2.1.0 in one implementation commit. A 2.1.0 validator rejects values outside `available` / `unavailable`; it does not require the field when validating a 2.0.0 archive through the upcaster. Until that Phase 1 commit, the current 2.0.0 runtime remains unchanged.

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

## 11. R2 key layout（既存2.0 artifact互換）

以下の`football/v2/...` keyは移行前に作成済みの2.0 artifactを読み戻すため維持する。新規のD1/R2配置、LIVE projection、archive keyは`data-storage-d1-r2-design-v1.0.md`を正本とし、この節からR2を恒久的な構造化factsの正本と解釈しない。

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

Competition-scoped JST date index:

```text
football/v2/indexes/competition/{competitionId}/date-jst/{YYYY-MM-DD}.json
```

Date-index fixtureは`kickoffUtc`、同時刻では`fixtureId`のcode-point順で並べる。competition-scoped indexはroot `competition`を必須とする。generic／competitionの期待scopeはpayload自身から導出せず、publisher、merge CLI、coverage plan、Worker routeが外部入力として必ず指定する。publisher、D1 coverage importer、Worker degraded fallbackは`shared/date-index-contract.mjs`のclosed-schema validatorを使用し、許可されていないroot／fixture／nested fieldを公開しない。

R2 mergeは宛先scopeと更新方式を明示する。完全なdateまたはcompetition取得は`replace`、league限定generic取得は`replace-scope`として当該competitionの旧fixtureを除去してから置換する。単純`upsert`は削除を表現しないため、権威集合更新として暗黙には使用しない。

D1 date-index coverageは件数だけでなく、fixture IDをcode-point順に並べた改行区切り列（末尾改行あり）のSHA-256を保持する。WorkerはD1 read結果だけから同じdigestを再計算し、件数保存型のidentity入替を拒否する。coverageの`generatedAt`はresponse内容全体の鮮度ではなく、fixture identity集合を検証した時刻を意味する。

The pointer allows the Worker to resolve a fixture by `fixtureId` without making the UI know the R2 hierarchy.

## 12. Git / D1 / R2 / KV / Cache API ownership

### Git

Human-authored / reviewable assets:
- application code
- Data Contract
- tracking configuration
- JFW crosswalk
- manual corrections and evidence
- rating algorithm

### D1

Canonical machine facts:
- competition / season / fixture compact facts
- hot events / lineups / appearances / stats
- latest/final standings and generated query indexes
- team / player masters and tracking-derived structured results

### R2

Non-canonical or archived objects:
- provider raw responses and audit snapshots
- validated response-ready LIVE projections before final D1 publication
- old fixture detail archives and manifests
- verified degraded-response snapshots reconstructable from D1/provider facts

### KV

Optional hot indexes and cache data only. KV must never be the only copy of a fact.

### `caches.default`

Saved Worker responsesのedge cache。公開requestからAPI-Footballを呼ばず、LIVEの取得頻度や履歴完成度を閲覧数に依存させない。

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
GET /api/v2/competitions/{competitionId}/dates/{YYYY-MM-DD}
GET /api/v2/competitions/{competitionId}/seasons/{seasonId}/standings
GET /health
```

R2 is private from the browser. Worker origin checks and a soft per-isolate abuse guard are defense in depth. Production deployment should also use Cloudflare's account/zone rate limiting configuration rather than treating in-memory Worker counters as a globally consistent limiter.

### Standings snapshots

The following R2 objects and manual workflow describe the current pre-migration 2.0 implementation. The D1 target stores latest/final structured standings in D1 and may retain historical/audit snapshots in R2 as defined by `data-storage-d1-r2-design-v1.0.md`.

Standings are normalized from API-Football `/standings` by `scripts/v2/fetch-standings.js`. Competition and season identity are provider-native. Each row preserves explicit provider zeroes while missing rank, points, goal difference and record fields remain `null`.

Every ingestion writes both an immutable timestamped snapshot and the latest object consumed by the Worker:

```text
football/v2/competitions/{competitionId}/seasons/{seasonId}/standings/snapshots/{timestamp}.json
football/v2/competitions/{competitionId}/seasons/{seasonId}/standings/latest.json
```

The manual `.github/workflows/v2-standings.yml` workflow accepts one API-Football league ID and one provider season. It publishes both objects without storing provider responses in Git.

## 15. Fixture lifecycle

Initial states:

```text
scheduled
live
provisional_final
finalized
needs_review
```

Live deliveryはscheduled ingestが作るD1 compact factsと検証済みR2 LIVE projectionを読む。公開requestはprovider fetchを起動せず、historical ingestionの完成度を閲覧数へ依存させない。

Separate reconciliation rule:

> Every 6 hours, inspect scheduled fixtures whose KO + 3 hours has passed and ensure a finalized D1 revision exists, or a complete verified bundle is queued in R2 for the next permitted D1 publish window.

This later reconcile job closes fixtures that nobody viewed live.

## 16. One-fixture vertical slice（移行前の既存実装）

この節は現行2.0 vertical sliceの回帰境界を記録するもので、D1/R2移行後のtarget runtimeではない。target runtimeと実装順序は`data-storage-d1-r2-design-v1.0.md`を正本とする。

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

## 17. Existing vertical slice acceptance criteria

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
