import fixtureImporterModule from '../scripts/d1/fixture-bundle-importer.js';

const {
  PLAYER_STAT_COLUMNS,
  TEAM_STAT_COLUMNS,
  assertCorrectionDefinitions,
  correctionDefinitions,
  validateBundle,
} = fixtureImporterModule;

export const FIXTURE_OPERATION = 'fixture_publish';
const SCORE_KINDS = ['halftime', 'fulltime', 'extratime', 'penalty'];
const SECTION_KEYS = ['events', 'lineups', 'teamStats', 'playerStats'];
const MAX_D1_QUERIES_PER_INVOCATION = 50;
const FIXTURE_PREFLIGHT_QUERY_BUDGET = 12;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function statement(database, sql, params = []) {
  return database.prepare(sql).bind(...params);
}

async function first(database, sql, params = []) {
  return database.prepare(sql).bind(...params).first();
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

export function assertFixtureRequest(input) {
  requireObject(input, 'Admin fixture ingest request');
  const allowed = new Set([
    'schemaVersion', 'operation', 'fixtureId', 'competitionId', 'seasonId',
    'catalog', 'correctionDefinitions',
  ]);
  const unknown = Object.keys(input).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Admin fixture ingest request contains unknown fields: ${unknown.join(', ')}.`);
  if (input.operation !== FIXTURE_OPERATION
    || !/^af:fixture:\d+$/.test(String(input.fixtureId || ''))
    || !/^af:competition:\d+$/.test(String(input.competitionId || ''))
    || !/^af:season:\d+:\d+$/.test(String(input.seasonId || ''))) {
    throw new Error('Admin fixture ingest scope is invalid.');
  }
  requireObject(input.catalog, 'Admin fixture catalog');
  requireObject(input.correctionDefinitions, 'Admin fixture correctionDefinitions');
  return input;
}

function expectedFixtureKey(input) {
  return `football/v2/competitions/${input.competitionId}/seasons/${input.seasonId}/fixtures/${input.fixtureId}.json`;
}

function revisionSelector() {
  return `fixture_id = (SELECT id FROM fixtures WHERE canonical_id = ?)
    AND revision_no = ?`;
}

function revisionParams(fixtureId, revision) {
  return [fixtureId, revision];
}

function entityValues(map) {
  return [...map.values()];
}

async function assertExistingIdentities(database, sourceCode, context) {
  const source = await first(database, 'SELECT id FROM provider_sources WHERE code = ?', [sourceCode]);
  const groups = [
    ['competitions', [context.normalized.competition], 'canonical_id'],
    ['teams', entityValues(context.teams), 'canonical_id'],
    ['players', entityValues(context.players), 'canonical_id'],
    ['coaches', entityValues(context.coaches), 'canonical_id'],
    ['venues', context.normalized.fixture.venue?.id ? [context.normalized.fixture.venue] : [], 'canonical_id'],
  ];
  for (const [table, entities, key] of groups) {
    for (const group of chunks(entities, 25)) {
      if (!group.length) continue;
      const result = await database.prepare(`
        SELECT ${key} AS canonical_id, source_id, provider_id FROM ${table}
        WHERE ${key} IN (${group.map(() => '?').join(', ')})
      `).bind(...group.map(item => item.id)).all();
      for (const row of result.results || []) {
        const expected = group.find(item => item.id === row.canonical_id);
        if (!expected || row.source_id !== source?.id || row.provider_id !== expected.providerId) {
          throw new Error(`Stored provider identity differs: ${row.canonical_id}.`);
        }
      }
    }
  }
  const storedSeason = await first(database, `
    SELECT competition.canonical_id AS competition_id, season.provider_season
    FROM competition_seasons season
    JOIN competitions competition ON competition.id = season.competition_id
    WHERE season.canonical_id = ?
  `, [context.normalized.season.id]);
  if (storedSeason && (storedSeason.competition_id !== context.normalized.competition.id
    || storedSeason.provider_season !== context.normalized.season.providerSeason)) {
    throw new Error(`Stored competition-season identity differs: ${context.normalized.season.id}.`);
  }
}

function assertFixtureCardinality(context) {
  const appearances = appearanceData(context);
  const lineupEntries = context.normalized.lineups
    .reduce((count, lineup) => count + lineup.startXI.length + lineup.substitutes.length, 0);
  const fieldStates = context.normalized.lineups
    .reduce((count, lineup) => count + Object.keys(lineup.fieldStates || {}).length, 0)
    + context.normalized.playerStats
      .reduce((count, stat) => count + Object.keys(stat.fieldStates || {}).length, 0);
  const limits = [
    ['events', context.normalized.events.length, 100],
    ['lineups', context.normalized.lineups.length, 2],
    ['appearances', appearances.length, 40],
    ['lineup entries', lineupEntries, 40],
    ['player stats', context.normalized.playerStats.length, 40],
    ['team stats', context.normalized.teamStats.length, 2],
    ['field states', fieldStates, 160],
  ];
  for (const [label, count, limit] of limits) {
    if (count > limit) throw new Error(`Fixture ${label} exceed the D1 publish limit (${count}/${limit}).`);
  }
  for (const stat of context.normalized.playerStats) {
    for (const fieldPath of Object.keys(stat.fieldIssues || {})) {
      if (!Object.hasOwn(stat.fieldStates || {}, fieldPath)) {
        throw new Error(`playerStats field issue lacks field state: ${stat.playerId}:${fieldPath}.`);
      }
    }
  }
  return appearances;
}

function addMasterStatements(database, statements, context, catalog) {
  const { normalized, source, teams, players, coaches, productSeasonId } = context;
  const competition = normalized.competition;
  const season = normalized.season;
  statements.push(statement(database, `
    INSERT INTO provider_sources(code, api_version) VALUES (?, ?)
    ON CONFLICT(code) DO UPDATE SET api_version = excluded.api_version
  `, [source, catalog.source.apiVersion]));
  statements.push(statement(database, `
    INSERT INTO competitions(
      canonical_id, source_id, provider_id, name, country_code, country_name, type, logo_url, flag_url
    ) VALUES (?, (SELECT id FROM provider_sources WHERE code = ?), ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_id) DO UPDATE SET
      name = excluded.name, country_code = excluded.country_code,
      country_name = excluded.country_name, type = excluded.type,
      logo_url = excluded.logo_url, flag_url = excluded.flag_url
  `, [competition.id, source, competition.providerId, competition.name,
    catalog.competition.countryCode || null, competition.country, catalog.competition.type,
    competition.logo, competition.flag]));
  statements.push(statement(database, `
    INSERT INTO competition_seasons(
      canonical_id, competition_id, product_season_id, provider_season, label,
      starts_on, ends_on, finalized_on, status
    ) VALUES (
      ?, (SELECT id FROM competitions WHERE canonical_id = ?),
      (SELECT id FROM product_seasons WHERE canonical_id = ?), ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(canonical_id) DO UPDATE SET product_season_id = excluded.product_season_id,
      label = excluded.label, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
      finalized_on = excluded.finalized_on, status = excluded.status
  `, [season.id, competition.id, productSeasonId, season.providerSeason, season.label,
    catalog.season.startsOn || null, catalog.season.endsOn || null,
    catalog.season.finalizedOn || null, catalog.season.status]));

  for (const group of chunks(entityValues(teams), 16)) {
    statements.push(statement(database, `
      INSERT INTO teams(canonical_id, source_id, provider_id, name, code, logo_url)
      VALUES ${group.map(() => '(?, (SELECT id FROM provider_sources WHERE code = ?), ?, ?, ?, ?)').join(', ')}
      ON CONFLICT(canonical_id) DO UPDATE SET name = excluded.name,
        code = COALESCE(excluded.code, teams.code), logo_url = excluded.logo_url
    `, group.flatMap(team => [team.id, source, team.providerId, team.name,
      team.code || null, team.logo || null])));
  }
  const teamValues = entityValues(teams);
  if (teamValues.length) {
    statements.push(statement(database, `
      INSERT OR IGNORE INTO competition_season_teams(competition_season_id, team_id)
      VALUES ${teamValues.map(() => `(
        (SELECT id FROM competition_seasons WHERE canonical_id = ?),
        (SELECT id FROM teams WHERE canonical_id = ?)
      )`).join(', ')}
    `, teamValues.flatMap(team => [season.id, team.id])));
  }
  for (const group of chunks(entityValues(players), 14)) {
    statements.push(statement(database, `
      INSERT INTO players(
        canonical_id, source_id, provider_id, display_name, nationality, birth_date, photo_url
      ) VALUES ${group.map(() => '(?, (SELECT id FROM provider_sources WHERE code = ?), ?, ?, ?, ?, ?)').join(', ')}
      ON CONFLICT(canonical_id) DO UPDATE SET display_name = excluded.display_name,
        nationality = COALESCE(excluded.nationality, players.nationality),
        birth_date = COALESCE(excluded.birth_date, players.birth_date),
        photo_url = COALESCE(excluded.photo_url, players.photo_url)
    `, group.flatMap(player => [player.id, source, player.providerId, player.name,
      player.nationality || null, player.birthDate || null, player.photo || null])));
  }
  for (const group of chunks(entityValues(coaches), 20)) {
    statements.push(statement(database, `
      INSERT INTO coaches(canonical_id, source_id, provider_id, display_name, photo_url)
      VALUES ${group.map(() => '(?, (SELECT id FROM provider_sources WHERE code = ?), ?, ?, ?)').join(', ')}
      ON CONFLICT(canonical_id) DO UPDATE SET display_name = excluded.display_name,
        photo_url = COALESCE(excluded.photo_url, coaches.photo_url)
    `, group.flatMap(coach => [coach.id, source, coach.providerId, coach.name, coach.photo || null])));
  }
  const venue = normalized.fixture.venue;
  if (venue?.id) {
    statements.push(statement(database, `
      INSERT INTO venues(canonical_id, source_id, provider_id, name, city)
      VALUES (?, (SELECT id FROM provider_sources WHERE code = ?), ?, ?, ?)
      ON CONFLICT(canonical_id) DO UPDATE SET name = excluded.name, city = excluded.city
    `, [venue.id, source, venue.providerId, venue.name, venue.city]));
  }
}

function correctedBaseBundle(normalized) {
  const copy = JSON.parse(JSON.stringify(normalized));
  for (const [path, override] of Object.entries(normalized.overrides || {})) {
    if (override.status !== 'active') continue;
    const parts = path.split('.').filter(Boolean);
    let current = copy;
    for (const part of parts.slice(0, -1)) current = current[part];
    current[parts.at(-1)] = override.correctedProviderValue;
  }
  return copy;
}

function addFixtureHeaderStatements(database, statements, context, contentSha256, previousRevisionId) {
  const { normalized, fixture, kickoffUtc, publishedAt, source } = context;
  const base = correctedBaseBundle(normalized).fixture;
  if (previousRevisionId) {
    statements.push(statement(database,
      'UPDATE fixtures SET published_revision = NULL WHERE canonical_id = ?', [fixture.id]));
    statements.push(statement(database, `
      UPDATE fixture_revisions SET lifecycle_state = 'superseded'
      WHERE id = ? AND lifecycle_state = 'published'
    `, [previousRevisionId]));
  }
  statements.push(statement(database, `
    INSERT INTO fixtures(
      canonical_id, source_id, provider_id, competition_season_id, venue_id,
      home_team_id, away_team_id, kickoff_utc, date_jst, round, referee,
      status_short, status_long, status_elapsed, home_goals, away_goals,
      home_winner, away_winner, ingestion_state
    ) VALUES (
      ?, (SELECT id FROM provider_sources WHERE code = ?), ?,
      (SELECT id FROM competition_seasons WHERE canonical_id = ?),
      (SELECT id FROM venues WHERE canonical_id = ?),
      (SELECT id FROM teams WHERE canonical_id = ?),
      (SELECT id FROM teams WHERE canonical_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(canonical_id) DO UPDATE SET
      source_id = excluded.source_id, provider_id = excluded.provider_id,
      competition_season_id = excluded.competition_season_id, venue_id = excluded.venue_id,
      home_team_id = excluded.home_team_id, away_team_id = excluded.away_team_id,
      kickoff_utc = excluded.kickoff_utc, date_jst = excluded.date_jst,
      round = excluded.round, referee = excluded.referee, status_short = excluded.status_short,
      status_long = excluded.status_long, status_elapsed = excluded.status_elapsed,
      home_goals = excluded.home_goals, away_goals = excluded.away_goals,
      home_winner = excluded.home_winner, away_winner = excluded.away_winner,
      ingestion_state = excluded.ingestion_state
  `, [fixture.id, source, fixture.providerId, fixture.seasonId, fixture.venue.id,
    fixture.teams.home.id, fixture.teams.away.id, kickoffUtc, fixture.dateJst,
    fixture.round, fixture.referee, fixture.status.short, fixture.status.long,
    fixture.status.elapsed, base.score.goals.home, base.score.goals.away,
    base.teams.home.winner === null ? null : Number(base.teams.home.winner),
    base.teams.away.winner === null ? null : Number(base.teams.away.winner),
    base.ingestionState]));
  statements.push(statement(database, `
    INSERT INTO fixture_revisions(
      fixture_id, revision_no, lifecycle_state, detail_location, content_sha256, created_at, published_at
    ) VALUES ((SELECT id FROM fixtures WHERE canonical_id = ?), ?, 'staging', 'd1', ?, ?, NULL)
  `, [fixture.id, fixture.revision, contentSha256, publishedAt]));
  statements.push(statement(database, `
    DELETE FROM fixture_score_parts
    WHERE fixture_id = (SELECT id FROM fixtures WHERE canonical_id = ?)
  `, [fixture.id]));
  statements.push(statement(database, `
    INSERT INTO fixture_score_parts(fixture_id, score_kind, home_value, away_value)
    VALUES ${SCORE_KINDS.map(() => '((SELECT id FROM fixtures WHERE canonical_id = ?), ?, ?, ?)').join(', ')}
  `, SCORE_KINDS.flatMap(kind => [fixture.id, kind, base.score[kind].home, base.score[kind].away])));
  statements.push(statement(database,
    'DELETE FROM correction_states WHERE target_canonical_id = ?', [fixture.id]));
}

function addLineupStatements(database, statements, context) {
  const { normalized, fixture } = context;
  const rev = revisionParams(fixture.id, fixture.revision);
  const lineups = normalized.lineups;
  if (lineups.length) {
    statements.push(statement(database, `
      INSERT INTO fixture_lineups(fixture_revision_id, team_id, coach_id, formation)
      VALUES ${lineups.map(() => `(
        (SELECT id FROM fixture_revisions WHERE ${revisionSelector()}),
        (SELECT id FROM teams WHERE canonical_id = ?),
        (SELECT id FROM coaches WHERE canonical_id = ?), ?
      )`).join(', ')}
    `, lineups.flatMap(lineup => [...rev, lineup.teamId, lineup.coach?.id || null, lineup.formation])));
  }
  const fieldStates = lineups.flatMap(lineup => Object.entries(lineup.fieldStates || {})
    .map(([fieldPath, state]) => ({ lineup, fieldPath, state })));
  for (const group of chunks(fieldStates, 12)) {
    statements.push(statement(database, `
      INSERT INTO field_states(
        fixture_revision_id, fact_kind, fact_key, field_path, presence, issue_flags_json
      ) VALUES ${group.map(() => `(
        (SELECT id FROM fixture_revisions WHERE ${revisionSelector()}), 'lineup', ?, ?, ?, '[]'
      )`).join(', ')}
    `, group.flatMap(item => [...rev, item.lineup.teamId, item.fieldPath, item.state.presence])));
  }
}

function appearanceData(context) {
  const lineupPlayers = new Map();
  for (const lineup of context.normalized.lineups) {
    for (const [role, entries] of [['starter', lineup.startXI], ['substitute', lineup.substitutes]]) {
      for (const [entryOrder, player] of entries.entries()) {
        lineupPlayers.set(player.id, { ...player, teamId: lineup.teamId, role, entryOrder });
      }
    }
  }
  return [...new Set([...lineupPlayers.keys(), ...context.playerStats.keys()])].map(playerId => {
    const lineup = lineupPlayers.get(playerId);
    const stat = context.playerStats.get(playerId);
    const teamId = stat?.teamId || lineup.teamId;
    const starter = stat?.starter;
    const appearanceState = starter === true ? 'started'
      : (starter === false && (stat.values.minutes || 0) > 0 ? 'substitute_used'
        : (starter === false ? 'bench_unused' : 'unknown'));
    return { playerId, lineup, stat, teamId, appearanceState };
  });
}

function appearanceSelector() {
  return `fixture_revision_id = (SELECT id FROM fixture_revisions WHERE ${revisionSelector()})
    AND player_record_id = (
      SELECT record.id FROM fixture_player_records record
      JOIN fixtures fixture ON fixture.id = record.fixture_id
      JOIN players player ON player.id = record.player_id
      WHERE fixture.canonical_id = ? AND player.canonical_id = ?
    )`;
}

function appearanceParams(fixture, playerId) {
  return [fixture.id, fixture.revision, fixture.id, playerId];
}

function addAppearanceStatements(database, statements, context) {
  const { fixture, kickoffUtc } = context;
  const appearances = appearanceData(context);
  for (const group of chunks(appearances, 12)) {
    statements.push(statement(database, `
      INSERT INTO fixture_player_records(fixture_id, team_id, player_id, kickoff_utc)
      VALUES ${group.map(() => `(
        (SELECT id FROM fixtures WHERE canonical_id = ?),
        (SELECT id FROM teams WHERE canonical_id = ?),
        (SELECT id FROM players WHERE canonical_id = ?), ?
      )`).join(', ')}
      ON CONFLICT(fixture_id, player_id) DO UPDATE SET kickoff_utc = excluded.kickoff_utc
    `, group.flatMap(item => [fixture.id, item.teamId, item.playerId, kickoffUtc])));
  }
  for (const group of chunks(appearances, 9)) {
    statements.push(statement(database, `
      INSERT INTO fixture_player_appearances(
        fixture_revision_id, player_record_id, appearance_state, position, minutes, captain
      ) VALUES ${group.map(() => `(
        (SELECT id FROM fixture_revisions WHERE ${revisionSelector()}),
        (SELECT record.id FROM fixture_player_records record
          JOIN fixtures fixture ON fixture.id = record.fixture_id
          JOIN players player ON player.id = record.player_id
          WHERE fixture.canonical_id = ? AND player.canonical_id = ?), ?, ?, ?, ?
      )`).join(', ')}
    `, group.flatMap(item => [fixture.id, fixture.revision, fixture.id, item.playerId,
      item.appearanceState, item.stat?.position ?? item.lineup?.position ?? null,
      item.stat?.values?.minutes ?? null,
      item.stat?.captain === null || item.stat?.captain === undefined ? null : Number(item.stat.captain)])));
  }
  const lineupEntries = appearances.filter(item => item.lineup);
  for (const group of chunks(lineupEntries, 8)) {
    statements.push(statement(database, `
      INSERT INTO fixture_lineup_entries(
        lineup_id, player_appearance_id, squad_role, entry_order, shirt_number, grid
      ) VALUES ${group.map(() => `(
        (SELECT lineup.id FROM fixture_lineups lineup
          JOIN fixture_revisions revision ON revision.id = lineup.fixture_revision_id
          JOIN fixtures fixture ON fixture.id = revision.fixture_id
          JOIN teams team ON team.id = lineup.team_id
          WHERE fixture.canonical_id = ? AND revision.revision_no = ? AND team.canonical_id = ?),
        (SELECT id FROM fixture_player_appearances WHERE ${appearanceSelector()}), ?, ?, ?, ?
      )`).join(', ')}
    `, group.flatMap(item => [fixture.id, fixture.revision, item.teamId,
      ...appearanceParams(fixture, item.playerId), item.lineup.role, item.lineup.entryOrder,
      item.lineup.number, item.lineup.grid])));
  }
  const statEntries = appearances.filter(item => item.stat);
  const statKeys = Object.keys(PLAYER_STAT_COLUMNS);
  const statColumns = statKeys.map(key => PLAYER_STAT_COLUMNS[key]);
  for (const group of chunks(statEntries, 2)) {
    const valueSql = `(
      (SELECT id FROM fixture_player_appearances WHERE ${appearanceSelector()}),
      ${statColumns.map(() => '?').join(', ')}, ?
    )`;
    statements.push(statement(database, `
      INSERT INTO fixture_player_stats(player_appearance_id, ${statColumns.join(', ')}, extra_stats_json)
      VALUES ${group.map(() => valueSql).join(', ')}
    `, group.flatMap(item => {
      const extra = Object.fromEntries(Object.entries(item.stat.values)
        .filter(([key]) => !PLAYER_STAT_COLUMNS[key]));
      return [...appearanceParams(fixture, item.playerId),
        ...statKeys.map(key => Object.hasOwn(item.stat.values, key) ? item.stat.values[key] : null),
        Object.keys(extra).length ? JSON.stringify(extra) : null];
    })));
  }
  const states = statEntries.flatMap(item => Object.entries(item.stat.fieldStates || {})
    .map(([fieldPath, state]) => ({ item, fieldPath, state })));
  for (const group of chunks(states, 10)) {
    statements.push(statement(database, `
      INSERT INTO field_states(
        fixture_revision_id, fact_kind, fact_key, field_path, presence, issue_flags_json
      ) VALUES ${group.map(() => `(
        (SELECT id FROM fixture_revisions WHERE ${revisionSelector()}), 'player_stat', ?, ?, ?, ?
      )`).join(', ')}
    `, group.flatMap(({ item, fieldPath, state }) => [fixture.id, fixture.revision,
      item.playerId, fieldPath, state.presence,
      JSON.stringify(item.stat.fieldIssues?.[fieldPath] || [])])));
  }
  return appearances;
}

function addRemainingDetailStatements(database, statements, context) {
  const { normalized, fixture, publishedAt } = context;
  const rev = revisionParams(fixture.id, fixture.revision);
  for (const group of chunks(normalized.events, 8)) {
    statements.push(statement(database, `
      INSERT INTO fixture_events(
        fixture_revision_id, event_key, team_id, player_id, related_player_id,
        elapsed, extra_minute, event_order, type, detail, comments
      ) VALUES ${group.map(() => `(
        (SELECT id FROM fixture_revisions WHERE ${revisionSelector()}), ?,
        (SELECT id FROM teams WHERE canonical_id = ?),
        (SELECT id FROM players WHERE canonical_id = ?),
        (SELECT id FROM players WHERE canonical_id = ?), ?, ?, ?, ?, ?, ?
      )`).join(', ')}
    `, group.flatMap(event => {
      const index = normalized.events.findIndex(item => item.id === event.id);
      return [...rev, event.id, event.teamId, event.playerId, event.relatedPlayerId,
        event.elapsed, event.extra, index, event.type, event.detail, event.comments];
    })));
  }
  const teamKeys = Object.keys(TEAM_STAT_COLUMNS);
  const teamColumns = teamKeys.map(key => TEAM_STAT_COLUMNS[key]);
  for (const group of chunks(normalized.teamStats, 6)) {
    const valueSql = `(
      (SELECT id FROM fixture_revisions WHERE ${revisionSelector()}),
      (SELECT id FROM teams WHERE canonical_id = ?), ${teamColumns.map(() => '?').join(', ')}, ?
    )`;
    statements.push(statement(database, `
      INSERT INTO fixture_team_stats(fixture_revision_id, team_id, ${teamColumns.join(', ')}, extra_stats_json)
      VALUES ${group.map(() => valueSql).join(', ')}
    `, group.flatMap(stat => {
      const extra = Object.fromEntries(Object.entries(stat.values)
        .filter(([key]) => !TEAM_STAT_COLUMNS[key]));
      return [...rev, stat.teamId,
        ...teamKeys.map(key => Object.hasOwn(stat.values, key) ? stat.values[key] : null),
        Object.keys(extra).length ? JSON.stringify(extra) : null];
    })));
  }
  statements.push(statement(database, `
    INSERT INTO section_states(fixture_revision_id, section_key, presence, observed_at)
    VALUES ${SECTION_KEYS.map(() => `(
      (SELECT id FROM fixture_revisions WHERE ${revisionSelector()}), ?, ?, ?
    )`).join(', ')}
  `, SECTION_KEYS.flatMap(key => {
    const presence = normalized.sectionStates[key].presence;
    return [...rev, key, presence === 'present' && normalized[key].length === 0 ? 'present_empty' : presence, publishedAt];
  })));
  const overrides = Object.entries(normalized.overrides || {});
  for (const group of chunks(overrides, 8)) {
    statements.push(statement(database, `
      INSERT INTO correction_states(
        correction_key, target_kind, target_canonical_id, field_path, status,
        provider_baseline_json, applied_value_json, reason, source_url, verified_at, reconciled_at
      ) VALUES ${group.map(() => "(?, 'fixture', ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(', ')}
    `, group.flatMap(([fieldPath, override]) => [
      `${fixture.id}:${fieldPath}`, fixture.id, fieldPath, override.status,
      JSON.stringify(override.correctedProviderValue), JSON.stringify(override.value),
      override.reason ?? null, override.sourceUrl ?? null, override.verifiedAt ?? null,
      override.reconciledAt,
    ])));
  }
}

function addIntegrityStatement(database, statements, context, appearances) {
  const { normalized, fixture } = context;
  const rev = revisionParams(fixture.id, fixture.revision);
  const lineupEntries = normalized.lineups
    .reduce((count, lineup) => count + lineup.startXI.length + lineup.substitutes.length, 0);
  const fieldStates = normalized.lineups
    .reduce((count, lineup) => count + Object.keys(lineup.fieldStates || {}).length, 0)
    + normalized.playerStats
      .reduce((count, stat) => count + Object.keys(stat.fieldStates || {}).length, 0);
  const expected = [
    ['fixture_score_parts', 'fixture_id = (SELECT id FROM fixtures WHERE canonical_id = ?)', [fixture.id], 4],
    ['fixture_events', `fixture_revision_id = (SELECT id FROM fixture_revisions WHERE ${revisionSelector()})`, rev, normalized.events.length],
    ['fixture_lineups', `fixture_revision_id = (SELECT id FROM fixture_revisions WHERE ${revisionSelector()})`, rev, normalized.lineups.length],
    ['fixture_player_appearances', `fixture_revision_id = (SELECT id FROM fixture_revisions WHERE ${revisionSelector()})`, rev, appearances.length],
    ['fixture_player_stats', `player_appearance_id IN (
      SELECT id FROM fixture_player_appearances WHERE fixture_revision_id = (
        SELECT id FROM fixture_revisions WHERE ${revisionSelector()}
      )
    )`, rev, normalized.playerStats.length],
    ['fixture_lineup_entries', `player_appearance_id IN (
      SELECT id FROM fixture_player_appearances WHERE fixture_revision_id = (
        SELECT id FROM fixture_revisions WHERE ${revisionSelector()}
      )
    )`, rev, lineupEntries],
    ['fixture_team_stats', `fixture_revision_id = (SELECT id FROM fixture_revisions WHERE ${revisionSelector()})`, rev, normalized.teamStats.length],
    ['section_states', `fixture_revision_id = (SELECT id FROM fixture_revisions WHERE ${revisionSelector()})`, rev, SECTION_KEYS.length],
    ['field_states', `fixture_revision_id = (SELECT id FROM fixture_revisions WHERE ${revisionSelector()})`, rev, fieldStates],
    ['correction_states', "target_kind = 'fixture' AND target_canonical_id = ?", [fixture.id], Object.keys(normalized.overrides || {}).length],
  ];
  const checks = expected.map(([table, where]) => `(SELECT COUNT(*) FROM ${table} WHERE ${where}) = ?`);
  const params = expected.flatMap(([, , values, count]) => [...values, count]);
  statements.push(statement(database, `
    UPDATE fixture_revisions SET lifecycle_state = 'invalid'
    WHERE ${revisionSelector()} AND NOT (${checks.join(' AND ')})
  `, [...rev, ...params]));
}

function addPublishStatements(database, statements, context, previousRevisionId) {
  const { fixture, publishedAt } = context;
  const rev = revisionParams(fixture.id, fixture.revision);
  statements.push(statement(database, `
    UPDATE fixture_revisions SET lifecycle_state = 'published', published_at = ?
    WHERE ${revisionSelector()}
  `, [publishedAt, ...rev]));
  statements.push(statement(database, `
    UPDATE fixtures SET published_revision = (
      SELECT id FROM fixture_revisions WHERE ${revisionSelector()}
    ) WHERE canonical_id = ?
  `, [...rev, fixture.id]));
  if (previousRevisionId) {
    for (const table of [
      'fixture_events', 'fixture_lineups', 'fixture_player_appearances',
      'fixture_team_stats', 'section_states', 'field_states',
    ]) statements.push(statement(database, `DELETE FROM ${table} WHERE fixture_revision_id = ?`, [previousRevisionId]));
  }
}

async function preflight(database, context, contentSha256) {
  const productSeason = await first(database,
    'SELECT id FROM product_seasons WHERE canonical_id = ?', [context.productSeasonId]);
  if (!productSeason) throw new Error(`Product season does not exist: ${context.productSeasonId}.`);
  const current = await first(database, `
    SELECT fixture.id, fixture.published_revision, fixture.provider_id,
      source.code AS source_code, revision.content_sha256, revision.revision_no
    FROM fixtures fixture
    JOIN provider_sources source ON source.id = fixture.source_id
    LEFT JOIN fixture_revisions revision ON revision.id = fixture.published_revision
    WHERE fixture.canonical_id = ?
  `, [context.fixture.id]);
  if (current && (current.provider_id !== context.fixture.providerId
    || current.source_code !== context.source)) {
    throw new Error(`Stored fixture provider identity differs: ${context.fixture.id}.`);
  }
  if (current?.content_sha256 === contentSha256) {
    if (current.revision_no !== context.fixture.revision) {
      throw new Error('Existing content hash has a different fixture revision.');
    }
    return { noOp: true, previousRevisionId: current.published_revision || null };
  }
  const next = await first(database, `
    SELECT COALESCE(MAX(revision.revision_no), 0) + 1 AS revision_no
    FROM fixture_revisions revision
    JOIN fixtures fixture ON fixture.id = revision.fixture_id
    WHERE fixture.canonical_id = ?
  `, [context.fixture.id]);
  const nextRevision = Number(next?.revision_no || 1);
  if (context.fixture.revision !== nextRevision) {
    throw new Error(`fixture.revision must be the next revision (${nextRevision}).`);
  }
  const records = await database.prepare(`
    SELECT player.canonical_id AS player_id, team.canonical_id AS team_id
    FROM fixture_player_records record
    JOIN fixtures fixture ON fixture.id = record.fixture_id
    JOIN players player ON player.id = record.player_id
    JOIN teams team ON team.id = record.team_id
    WHERE fixture.canonical_id = ?
  `).bind(context.fixture.id).all();
  const expected = new Map(appearanceData(context).map(item => [item.playerId, item.teamId]));
  for (const record of records.results || []) {
    if (expected.has(record.player_id) && expected.get(record.player_id) !== record.team_id) {
      throw new Error(`Existing player record has a different team: ${record.player_id}.`);
    }
  }
  return { noOp: false, previousRevisionId: current?.published_revision || null };
}

export async function publishFixtureFromR2(env, input) {
  if (!env.FOOTBALL_DB || !env.FOOTBALL_DATA) throw new Error('Admin ingest bindings are unavailable.');
  assertFixtureRequest(input);
  const sourceR2Key = expectedFixtureKey(input);
  const object = await env.FOOTBALL_DATA.get(sourceR2Key);
  if (!object) {
    const error = new Error('Fixture R2 object is missing.');
    error.status = 404;
    throw error;
  }
  const raw = await object.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('Fixture R2 object is not JSON.'); }
  if (payload?.fixture?.id !== input.fixtureId
    || payload?.fixture?.competitionId !== input.competitionId
    || payload?.fixture?.seasonId !== input.seasonId) {
    throw new Error('Fixture R2 object does not match the externally declared scope.');
  }
  const context = validateBundle(payload, input.catalog);
  assertCorrectionDefinitions(context.normalized, input.correctionDefinitions);
  const boundedAppearances = assertFixtureCardinality(context);
  await assertExistingIdentities(env.FOOTBALL_DB, context.source, context);
  const sourceSha256 = await sha256(raw);
  const contentSha256 = await sha256(stableStringify(context.normalized));
  const checked = await preflight(env.FOOTBALL_DB, context, contentSha256);
  if (checked.noOp) {
    return {
      schemaVersion: 'jfw-d1-admin-ingest-report/1', operation: FIXTURE_OPERATION,
      fixtureId: input.fixtureId, sourceR2Key, sourceSha256, contentSha256,
      imported: false, reason: 'already_published', revision: context.fixture.revision,
    };
  }
  const statements = [];
  addMasterStatements(env.FOOTBALL_DB, statements, context, input.catalog);
  addFixtureHeaderStatements(env.FOOTBALL_DB, statements, context, contentSha256, checked.previousRevisionId);
  addLineupStatements(env.FOOTBALL_DB, statements, context);
  addAppearanceStatements(env.FOOTBALL_DB, statements, context);
  addRemainingDetailStatements(env.FOOTBALL_DB, statements, context);
  addIntegrityStatement(env.FOOTBALL_DB, statements, context, boundedAppearances);
  addPublishStatements(env.FOOTBALL_DB, statements, context, checked.previousRevisionId);
  const maxStatements = MAX_D1_QUERIES_PER_INVOCATION - FIXTURE_PREFLIGHT_QUERY_BUDGET;
  if (statements.length > maxStatements) {
    throw new Error(`Fixture publish exceeds the D1 query budget (${statements.length + FIXTURE_PREFLIGHT_QUERY_BUDGET}/${MAX_D1_QUERIES_PER_INVOCATION}).`);
  }
  await env.FOOTBALL_DB.batch(statements);
  return {
    schemaVersion: 'jfw-d1-admin-ingest-report/1', operation: FIXTURE_OPERATION,
    fixtureId: input.fixtureId, sourceR2Key, sourceSha256, contentSha256,
    imported: true, revision: context.fixture.revision, statementCount: statements.length,
    counts: {
      events: context.normalized.events.length, lineups: context.normalized.lineups.length,
      appearances: boundedAppearances.length, playerStats: context.normalized.playerStats.length,
      teamStats: context.normalized.teamStats.length,
      correctionDefinitions: correctionDefinitions(context.normalized).length,
    },
  };
}
