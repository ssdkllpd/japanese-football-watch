'use strict';

const { buildAvailableBundle, buildUnavailableBundle } = require('./fixture-dto');

const HEADER_SQL = `
SELECT
  f.id AS fixture_row_id,
  f.canonical_id AS fixture_id,
  f.provider_id AS fixture_provider_id,
  f.kickoff_utc,
  f.date_jst,
  f.round,
  f.referee,
  f.status_short,
  f.status_long,
  f.status_elapsed,
  f.home_goals,
  f.away_goals,
  f.home_winner,
  f.away_winner,
  f.ingestion_state,
  f.published_revision,
  source.code AS source_code,
  competition.canonical_id AS competition_id,
  competition.provider_id AS competition_provider_id,
  competition.name AS competition_name,
  competition.country_name AS competition_country,
  competition.logo_url AS competition_logo,
  competition.flag_url AS competition_flag,
  season.canonical_id AS season_id,
  season.provider_season,
  season.label AS season_label,
  venue.canonical_id AS venue_id,
  venue.provider_id AS venue_provider_id,
  venue.name AS venue_name,
  venue.city AS venue_city,
  home.canonical_id AS home_team_id,
  home.provider_id AS home_team_provider_id,
  home.name AS home_team_name,
  home.logo_url AS home_team_logo,
  away.canonical_id AS away_team_id,
  away.provider_id AS away_team_provider_id,
  away.name AS away_team_name,
  away.logo_url AS away_team_logo,
  revision.revision_no,
  revision.lifecycle_state,
  revision.detail_location,
  revision.content_sha256 AS revision_content_sha256,
  revision.created_at AS revision_created_at,
  revision.published_at,
  archive.schema_version AS archive_schema_version,
  archive.r2_key AS archive_r2_key,
  archive.content_sha256 AS archive_content_sha256
FROM fixtures f
JOIN provider_sources source ON source.id = f.source_id
JOIN competition_seasons season ON season.id = f.competition_season_id
JOIN competitions competition ON competition.id = season.competition_id
JOIN teams home ON home.id = f.home_team_id
JOIN teams away ON away.id = f.away_team_id
LEFT JOIN venues venue ON venue.id = f.venue_id
LEFT JOIN fixture_revisions revision
  ON revision.id = f.published_revision
  AND revision.fixture_id = f.id
  AND revision.lifecycle_state = 'published'
LEFT JOIN fixture_archives archive
  ON archive.fixture_revision_id = revision.id
  AND archive.status = 'ready'
  AND archive.is_active = 1
WHERE f.canonical_id = ?1
LIMIT 1`;

const DETAIL_SQL = `
SELECT kind, sort_group, sort_a, sort_b, payload
FROM (
  SELECT
    'score' AS kind,
    0 AS sort_group,
    score_kind AS sort_a,
    '' AS sort_b,
    json_object(
      'scoreKind', score_kind,
      'home', home_value,
      'away', away_value
    ) AS payload
  FROM fixture_score_parts
  WHERE fixture_id = ?2

  UNION ALL

  SELECT
    'event',
    1,
    printf('%05d', COALESCE(event.elapsed, -1)),
    printf('%05d:%05d', COALESCE(event.extra_minute, -1), event.event_order),
    json_object(
      'eventKey', event.event_key,
      'teamId', team.canonical_id,
      'playerId', player.canonical_id,
      'relatedPlayerId', related.canonical_id,
      'elapsed', event.elapsed,
      'extraMinute', event.extra_minute,
      'eventOrder', event.event_order,
      'type', event.type,
      'detail', event.detail,
      'comments', event.comments
    )
  FROM fixture_events event
  LEFT JOIN teams team ON team.id = event.team_id
  LEFT JOIN players player ON player.id = event.player_id
  LEFT JOIN players related ON related.id = event.related_player_id
  WHERE event.fixture_revision_id = ?1

  UNION ALL

  SELECT
    'lineup',
    2,
    team.canonical_id,
    '',
    json_object(
      'lineupId', lineup.id,
      'teamId', team.canonical_id,
      'formation', lineup.formation,
      'coachId', coach.canonical_id,
      'coachProviderId', coach.provider_id,
      'coachName', coach.display_name,
      'coachPhoto', coach.photo_url
    )
  FROM fixture_lineups lineup
  JOIN teams team ON team.id = lineup.team_id
  LEFT JOIN coaches coach ON coach.id = lineup.coach_id
  WHERE lineup.fixture_revision_id = ?1

  UNION ALL

  SELECT
    'appearance',
    3,
    team.canonical_id,
    printf('%010d', appearance.id),
    json_object(
      'appearanceId', appearance.id,
      'playerRecordId', record.id,
      'lineupId', entry.lineup_id,
      'playerId', player.canonical_id,
      'playerProviderId', player.provider_id,
      'playerName', player.display_name,
      'playerPhoto', player.photo_url,
      'teamId', team.canonical_id,
      'appearanceState', appearance.appearance_state,
      'position', appearance.position,
      'minutes', appearance.minutes,
      'captain', appearance.captain,
      'hasStats', stats.player_appearance_id IS NOT NULL,
      'squadRole', entry.squad_role,
      'shirtNumber', entry.shirt_number,
      'grid', entry.grid,
      'valuesJson', json_object(
        'minutes', stats.minutes,
        'rating', stats.provider_rating,
        'goals', stats.goals,
        'assists', stats.assists,
        'goalsConceded', stats.goals_conceded,
        'saves', stats.saves,
        'shots', stats.shots,
        'shotsOnTarget', stats.shots_on_target,
        'passes', stats.passes,
        'keyPasses', stats.key_passes,
        'passAccuracy', stats.pass_accuracy,
        'tackles', stats.tackles,
        'blocks', stats.blocks,
        'interceptions', stats.interceptions,
        'duels', stats.duels,
        'duelsWon', stats.duels_won,
        'dribbleAttempts', stats.dribble_attempts,
        'dribbles', stats.dribbles,
        'dribbledPast', stats.dribbled_past,
        'foulsDrawn', stats.fouls_drawn,
        'foulsCommitted', stats.fouls_committed,
        'yellowCards', stats.yellow_cards,
        'redCards', stats.red_cards,
        'penaltiesWon', stats.penalties_won,
        'penaltiesConceded', stats.penalties_conceded,
        'penaltiesScored', stats.penalties_scored,
        'penaltiesMissed', stats.penalties_missed,
        'penaltiesSaved', stats.penalties_saved
      )
    )
  FROM fixture_player_appearances appearance
  JOIN fixture_player_records record ON record.id = appearance.player_record_id
  JOIN players player ON player.id = record.player_id
  JOIN teams team ON team.id = record.team_id
  LEFT JOIN fixture_lineup_entries entry ON entry.player_appearance_id = appearance.id
  LEFT JOIN fixture_player_stats stats ON stats.player_appearance_id = appearance.id
  WHERE appearance.fixture_revision_id = ?1

  UNION ALL

  SELECT
    'team_stat',
    4,
    team.canonical_id,
    '',
    json_object(
      'teamId', team.canonical_id,
      'valuesJson', json_object(
        'total_shots', stats.shots_total,
        'shots_on_goal', stats.shots_on_goal,
        'ball_possession', stats.possession_percent,
        'total_passes', stats.passes_total,
        'passes_accurate', stats.passes_accurate,
        'fouls', stats.fouls,
        'corner_kicks', stats.corners
      ),
      'extraStatsJson', stats.extra_stats_json
    )
  FROM fixture_team_stats stats
  JOIN teams team ON team.id = stats.team_id
  WHERE stats.fixture_revision_id = ?1
)
ORDER BY sort_group, sort_a, sort_b`;

const STATE_SQL = `
SELECT kind, payload
FROM (
  SELECT
    'section_state' AS kind,
    json_object(
      'sectionKey', section_key,
      'presence', presence,
      'sourceRecordId', source_record_id,
      'observedAt', observed_at
    ) AS payload
  FROM section_states
  WHERE fixture_revision_id = ?1

  UNION ALL

  SELECT
    'field_state',
    json_object(
      'factKind', fact_kind,
      'factKey', fact_key,
      'fieldPath', field_path,
      'presence', presence,
      'sourceRecordId', source_record_id,
      'issueFlagsJson', issue_flags_json
    )
  FROM field_states
  WHERE fixture_revision_id = ?1

  UNION ALL

  SELECT
    'correction',
    json_object(
      'correctionKey', correction_key,
      'fieldPath', field_path,
      'status', status,
      'providerBaselineJson', provider_baseline_json,
      'appliedValueJson', applied_value_json,
      'reconciledAt', reconciled_at
    )
  FROM correction_states
  WHERE target_canonical_id = ?2
)
ORDER BY kind, payload`;

function results(response) {
  if (Array.isArray(response)) return response;
  return Array.isArray(response?.results) ? response.results : [];
}

class FixtureRepository {
  constructor(db, options = {}) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('A D1-compatible database binding is required.');
    this.db = db;
    this.correctionDefinitions = options.correctionDefinitions || [];
  }

  async resolveFixture(fixtureId) {
    const header = await this.db.prepare(HEADER_SQL).bind(fixtureId).first();
    if (!header) return null;

    const detailRows = results(await this.db.prepare(DETAIL_SQL)
      .bind(header.published_revision, header.fixture_row_id)
      .all());

    if (header.detail_location === 'r2' && header.archive_r2_key) {
      return {
        source: 'r2',
        fixtureId: header.fixture_id,
        archive: {
          key: header.archive_r2_key,
          schemaVersion: header.archive_schema_version,
          contentSha256: header.archive_content_sha256,
        },
        compact: buildUnavailableBundle(header, detailRows).fixture,
      };
    }

    if (!header.published_revision || header.detail_location !== 'd1') {
      return {
        source: 'd1',
        bundle: buildUnavailableBundle(header, detailRows),
      };
    }

    const stateRows = results(await this.db.prepare(STATE_SQL)
      .bind(header.published_revision, header.fixture_id)
      .all());
    return {
      source: 'd1',
      bundle: buildAvailableBundle(header, detailRows, stateRows, {
        correctionDefinitions: this.correctionDefinitions,
      }),
    };
  }
}

module.exports = {
  DETAIL_SQL,
  FixtureRepository,
  HEADER_SQL,
  STATE_SQL,
};
