# Existing UI data coverage audit — 2026-09-17

## Scope

This audit covers the fixed API-Football snapshot `20260908-021509068Z` already migrated to D1.
It does not re-fetch API-Football and does not evaluate scheduled synchronization.

## Classification

| Visible symptom | Classification before this change | Evidence | Resolution |
| --- | --- | --- | --- |
| A canonical league deep link sometimes showed `大会情報は未取得` | Public API/UI gap | The public Worker had no competition directory endpoint. The UI learned competition identity only from the selected date's fixtures. | Added `GET /api/v2/competitions`; the UI loads canonical competition, season and logo identity before resolving the route. |
| `Premier League` appeared twice, once with a `legacy:` ID | UI identity adaptation bug | Legacy display labels were always converted to new `legacy:competition:*` identities even when `competitionAliases` already mapped the label to `af:competition:39`. | Legacy aliases now merge into the canonical competition identity. |
| League logos appeared or disappeared depending on navigation order | Public API/UI gap | The directory was derived from the currently loaded fixture list. A date without that league supplied no logo. | Logos now come from D1 competition identity. Image failures use a stable placeholder. |
| `概要`, `選手成績`, `チーム成績` showed `準備中` | UI/API unimplemented | The UI returned a hard-coded placeholder and the Worker exposed neither a competition directory nor a season aggregate route. | Added season summary, section coverage and player aggregates. Team results use the complete standings DTO already stored in D1. |
| Premier League standings show the 2026-09-08 snapshot rather than current results | Source snapshot is stale, not a migration loss | The stored standings publication has its own `generatedAt`. Automatic API-Football synchronization remains disabled by project policy. | The UI now displays the standings update timestamp. Current results require the later automation phase. |
| A scheduled fixture has no lineup/events/stats | Not fetched by design | Only the 365 completed fixture details in the fixed snapshot were migrated; the 3,420-fixture schedule also includes fixtures without completed detail. | Keep `not_fetched`; never convert it to an empty result or zero. |
| A completed fixture section is empty | Provider result, retrieval state, or true empty result | D1 `section_states` preserves `present`, `present_empty`, `not_fetched`, `provider_missing`, and `not_applicable`. | The overview now reports section counts separately. `present_empty` remains a fetched empty collection. |
| Some player rows are absent | API-Football returned unusable or conflicting identity | The reviewed snapshot configuration records 13 endpoint rows with `player.id` equal to `0` or `null`, plus separately reviewed positive-ID identity collisions. Raw source rows remain in the pinned R2 snapshot; unsafe rows were omitted from canonical D1 facts. | Continue the reviewed omission policy; do not invent `af:player:0` or merge distinct people. |
| A numeric player-stat scalar is NULL | Exact cause is not always recoverable per field | The contract preserves section-level state and sparse field exceptions. It explicitly forbids treating a missing scalar as provider-missing unless the endpoint contract guarantees the field. | Season aggregates expose NULL as `not_fetched` and preserve explicit zero as `present`. They do not claim API-Football omitted a field when the saved evidence cannot prove that. |

## Data-path verdict

The visible gaps had more than one cause:

1. Competition names, seasons and logos were stored in D1 but were not exposed through a stable public directory.
2. Three league tabs were intentionally unimplemented in the UI.
3. Some source rows were intentionally excluded because API-Football returned no usable player identity or a conflicting identity.
4. Some values are genuinely not fetched or unavailable from the pinned source and must remain missing.

The new endpoints and UI close items 1 and 2 without changing the stored snapshot. Items 3 and 4 remain explicit data-quality states rather than being silently replaced with zero.

## Regression gates

- Competition identity and logo load without a current-date fixture.
- A legacy display label cannot duplicate an existing canonical competition.
- `provider_missing`, `not_fetched`, fetched empty, explicit zero and NULL remain distinct.
- League overview, player statistics and team statistics no longer depend on placeholder content.
- No API-Football request is made by this change.
