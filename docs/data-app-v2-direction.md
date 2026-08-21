# Football Data App v2 — Product / UI Direction

Status: mandatory direction as of 2026-08-21

## 1. Product position

The application is no longer presented primarily as a Japanese-player tracking app.

The primary product is a general football data application inspired by the information architecture and usability of FotMob: match discovery, competition browsing, standings, clubs, players, lineups, match events and statistics.

Japanese-player tracking remains a first-class optional module layered on top of the general football data model. Existing Japanese tracking data, JFW Rating, watch history and tracking-specific analysis must not be deleted.

## 2. Data-domain split

### Core football data

Core data is competition / fixture centric and must not depend on whether a Japanese player is involved.

Required entities:
- competitions / competition-specific seasons
- fixtures and match status
- teams
- standings
- players
- coaches
- lineups / formations
- substitutions and match events
- match and player statistics
- provider ratings

API-Football is the primary provider for this layer. API keys must never be exposed to the browser.

The Core layer is the only owner of football facts. Japanese players are ordinary players in this layer. Their appearances, goals, assists, minutes, lineups and match statistics must not be copied into a second tracking fact store.

General identity is provider-native and explicit:
- `af:competition:<id>`
- `af:season:<competitionId>:<providerSeason>`
- `af:fixture:<id>`
- `af:team:<id>`
- `af:player:<id>`
- `af:coach:<id>`

Unknown provider players are accepted by the Core layer. A tracking registry is never allowed to fail-close the general football feed.

### Japanese tracking overlay

The Japanese tracking module is a view + derived-data layer over Core.

It owns:
- `trackedPlayerIds`
- provider-independent JFW player identity / crosswalk for tracked Japanese players
- manual membership corrections when provider membership is demonstrably wrong or incomplete
- JFW Rating
- Japanese-player rankings
- attention / insight values
- tracking-specific notification rules
- tracking data-quality state

It does **not** own duplicate copies of goals, assists, minutes, lineups or player match statistics.

Fail-closed registry checks apply only to the Japanese Tracking layer. J1 can exist in Core while remaining excluded from the overseas-Japanese tracking workflow. J1 completeness must not block that tracking workflow.

## 3. Primary navigation

Mobile-first bottom navigation:
1. 試合
2. リーグ
3. フォロー中
4. 日本人
5. その他

Do not add a News tab until a real news data source exists.

Desktop should expose the same information architecture with a wider layout rather than a different product structure.

## 4. Match screen

Default landing page is `試合`, not a Japanese-player dashboard.

Required layout:
- compact top app bar
- Live filter
- horizontal date strip with yesterday / today / tomorrow navigation
- competitions grouped into cards / sections
- each fixture row shows status/time, home team, away team, score and relevant live state
- followed competitions / clubs can be prioritised
- tapping a fixture opens match detail

The page must remain useful even when no tracked Japanese player is involved.

Canonical fixture timestamps are stored in UTC. Product-day indexing and default display use `Asia/Tokyo` / JST. R2 date keys therefore use an explicit `date-jst` namespace.

## 5. Competition / league directory

Required layout:
- search
- followed competitions section
- browseable competition list
- follow / unfollow action
- league detail route

League detail should support:
- competition-specific season selector
- overview
- matches
- standings
- player statistics
- team statistics

There is no single global season ID. Competition A may use an autumn-spring season while Competition B uses a calendar year.

Tabs may be hidden when the corresponding provider data has not been ingested yet. Missing provider data must never be represented as zero.

## 6. Follow experience

The app should allow following:
- competitions
- clubs
- players

Followed content influences ordering in the match feed and is visible from `フォロー中`.

Existing local favourites may be migrated instead of discarded.

## 7. Japanese tracking module

`日本人` is a dedicated optional view, not the application home page.

It should contain the existing differentiating features:
- tracked-player list
- player search/filter
- G/A and appearance rankings derived from Core facts
- JFW Rating derived from Core player-match facts
- recently active / notable players
- Japanese-player match history as a Core query/view
- transfer / membership-aware derived aggregates

Japanese tracking badges can also appear contextually in generic match, club and player pages.

## 8. Visual direction

Use the supplied FotMob screenshots as a usability / information-density reference, not as a pixel-for-pixel copy.

Required characteristics:
- restrained dark theme by default
- dense but readable information hierarchy
- compact cards and rows
- clear live / score status pills
- stable bottom navigation on mobile
- less decorative hero content
- less vertical whitespace
- football content visible immediately above the fold
- consistent club / competition badges and player photos when public provider media URLs are available

The previous large Japanese-tracking hero/dashboard presentation is no longer the default UX.

## 9. Formation rendering contract

Formation layout uses the provider formation string as the first structural source and grid as within-band ordering guidance.

Fallback chain:
1. valid formation string + usable grid => `high`
2. grid-derived structure => `medium`
3. player position code => `low`
4. even fallback => `none`

Vertical placement is semantic-band based rather than max-row interpolation. GK / DEF / DM / CM / AM / FW bands therefore remain stable across shapes. The pitch keeps a 2:3 CSS aspect ratio. UI must show `配置は推定` whenever the layout cannot be established at high confidence.

## 10. Runtime architecture

The application intentionally separates live delivery from finalized-data ingestion.

### Static UI

GitHub Pages is used for development / personal-use / preview hosting. It is not the canonical machine-fact store.

### Live path

```text
Browser
  -> Cloudflare Worker
  -> caches.default (60 second TTL, demand driven)
  -> API-Football /fixtures?live=all on cache miss
```

The Worker performs only:
- API key secrecy
- origin restriction
- lightweight abuse / rate guard
- Cache API access
- LiveFixtureDTO projection
- R2 read delivery

The Worker must not perform full normalization, reconciliation or JFW Rating calculation.

The LiveFixtureDTO boundary prevents API-Football response schema from leaking directly into UI code.

### Finalized / historical path

```text
API-Football detail endpoints
  -> GitHub Actions / Node normalization + reconciliation
  -> Cloudflare R2 canonical fixture bundle
  -> Worker read API
  -> UI
```

R2 is the canonical machine-generated fact store. KV may later hold hot indexes / cache data, but anything placed in KV must be reconstructable from R2 or provider facts.

R2 is not exposed to the browser through `r2.dev`; history is delivered through the Worker.

## 11. Live demand vs finalization completeness

Demand-driven live fetching must never determine whether historical data exists.

A separate reconciliation job must periodically find fixtures where:
- scheduled kickoff + 3 hours has passed; and
- no finalized R2 fixture bundle exists.

Initial target cadence: once every 6 hours. That job may run late without damaging live UX because it exists to close historical holes, not to provide minute-by-minute scores.

Fixture ingestion states:
- `scheduled`
- `live`
- `provisional_final`
- `finalized`
- `needs_review`

## 12. Storage boundary

Rule:

> git = human-authored decisions. R2 = machine-acquired football facts.

### Git
- UI / application code
- Data Contract definitions
- tracked-player configuration
- Japanese tracking crosswalk
- manual corrections with reason / evidence
- JFW Rating algorithm and rules

### R2
- canonical fixture bundles
- lineups
- events
- team and player match statistics
- provider ratings
- standings snapshots
- team / player master snapshots
- indexes derived from machine facts

A fixture is the basic canonical bundle and revision unit.

## 13. Provenance and missing-state policy

Provenance is record-level by default, with sparse field-level exceptions.

Presence:
- `present`
- `not_fetched`
- `provider_missing`
- `not_applicable`

Verification:
- `verified`
- `provider`
- `legacy_unverified`

Issues are independent and may be combined:
- `stale`
- `conflict`

This permits a value to be both stale and conflicted without overloading a single enum.

Missing data must never be coerced to zero. Explicit provider zero remains a legitimate value.

## 14. Manual correction reconciliation

Manual corrections are stored in Git and state what provider value was corrected.

For a correction with:
- manual value `M`
- provider value observed when corrected `P0`
- current provider value `P1`

Rules:
1. `P1 == P0` -> correction remains active.
2. `P1 == M` -> provider has caught up; correction becomes inactive candidate.
3. otherwise -> mark `conflict`, set fixture `needs_review`, and do not silently choose a winner.

Corrections do not expire merely because time passed.

## 15. API-Football integration consequences

The current API-Football work is not sufficient if it only backfills already-known Japanese-player matches.

The provider pipeline must additionally support a general football feed for configured competitions, including at minimum:
- fixtures by date / competition
- live/final fixture status
- standings
- team identity / logo
- player and coach identity / photo
- events
- lineups / formation
- player fixture statistics

Competition selection should be ID-based, not localized-name string matching.

## 16. Migration order

Do not leave the working Japanese tracker isolated until the end of a long rewrite.

Required sequence:
1. define and test the v2 Data Contract
2. prove one fixture end-to-end: API-Football -> Actions -> R2 -> Worker -> UI
3. broaden the generic core feed
4. move existing Japanese tracking onto Core facts while preserving parity
5. build the new match home and match detail
6. build league / club / player views
7. migrate favourites into generic follow
8. remove legacy default dashboard only after parity is confirmed

At every stage, stopping development should still leave a working application rather than two half-maintained architectures.
