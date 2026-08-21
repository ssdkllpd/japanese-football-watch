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
- competitions / seasons
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

### Japanese tracking overlay

The Japanese tracking module consumes the core entities where possible and adds:
- tracked Japanese player membership
- Japanese-player filters and follow views
- JFW Rating
- per-player season / competition / club aggregates
- Japanese-player match history
- tracking-specific milestones / insights / data-quality state

The overseas-Japanese tracking scope remains independent from the general football-data scope. J1 may be available in the general data UI, while J1 must not become a blocker for the overseas-Japanese tracking workflow.

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

## 5. Competition / league directory

Required layout:
- search
- followed competitions section
- browseable competition list
- follow / unfollow action
- league detail route

League detail should support:
- season selector
- overview
- matches
- standings
- player statistics
- team statistics

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
- G/A and appearance rankings
- JFW Rating
- recently active / notable players
- Japanese-player match history
- transfer / membership-aware aggregates

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

## 9. API-Football integration consequences

The current API-Football work is not sufficient for this product direction if it only backfills already-known Japanese-player matches.

The provider pipeline must additionally support a general football feed for configured competitions, including at minimum:
- fixtures by date / competition
- live/final fixture status
- standings
- team identity / logo
- player and coach identity / photo
- events
- lineups / formation
- player fixture statistics

Scheduled synchronization can only be enabled after quota, reconciliation and missing-value guards remain enforced.

## 10. Migration principle

Do not delete working tracking features while rebuilding the shell. Migrate incrementally:
1. introduce generic core schema/feed
2. build the new match and league shell
3. connect club / player / match detail pages
4. move existing tracking dashboards under `日本人`
5. migrate favourites into the generic follow model
6. remove the legacy dashboard only after feature parity is confirmed
