'use strict';

const { normalizeFixtureBundle } = require('./fixture-shadow-compare');
const { sha256, stableStringify } = require('./fixed-snapshot');

const SECTION_KEYS = ['events', 'lineups', 'teamStats', 'playerStats'];
const PRESENCES = new Set(['present', 'not_fetched', 'provider_missing', 'not_applicable']);
const INGESTION_STATES = new Set(['scheduled', 'live', 'provisional_final', 'finalized', 'needs_review']);
const EVENT_TYPES = new Set(['goal', 'card', 'substitution', 'var', 'other']);
const COMPETITION_TYPES = new Set(['League', 'Cup']);
const SCORE_KINDS = ['halftime', 'fulltime', 'extratime', 'penalty'];
const CORRECTION_DEFINITIONS_SCHEMA_VERSION = 'd1-fixture-correction-definitions/1';

const PLAYER_STAT_COLUMNS = {
  minutes: 'minutes', rating: 'provider_rating', goals: 'goals', assists: 'assists',
  goalsConceded: 'goals_conceded', saves: 'saves', shots: 'shots', shotsOnTarget: 'shots_on_target',
  passes: 'passes', keyPasses: 'key_passes', passAccuracy: 'pass_accuracy', tackles: 'tackles',
  blocks: 'blocks', interceptions: 'interceptions', duels: 'duels', duelsWon: 'duels_won',
  dribbleAttempts: 'dribble_attempts', dribbles: 'dribbles', dribbledPast: 'dribbled_past',
  foulsDrawn: 'fouls_drawn', foulsCommitted: 'fouls_committed', yellowCards: 'yellow_cards',
  redCards: 'red_cards', penaltiesWon: 'penalties_won', penaltiesConceded: 'penalties_conceded',
  penaltiesScored: 'penalties_scored', penaltiesMissed: 'penalties_missed', penaltiesSaved: 'penalties_saved',
};

const TEAM_STAT_COLUMNS = {
  total_shots: 'shots_total', shots_on_goal: 'shots_on_goal', ball_possession: 'possession_percent',
  total_passes: 'passes_total', passes_accurate: 'passes_accurate', fouls: 'fouls', corner_kicks: 'corners',
};

function row(database, sql, ...params) {
  return database.prepare(sql).get(...params) || null;
}

function run(database, sql, ...params) {
  return database.prepare(sql).run(...params);
}

function assertProviderIdentity(entity, expectedProviderId, expectedSourceId, path) {
  if (!entity || entity.provider_id !== expectedProviderId || entity.source_id !== expectedSourceId) {
    throw new Error(`${path} conflicts with existing provider identity.`);
  }
}

function requireValue(value, path) {
  if (value === null || value === undefined || value === '') throw new Error(`${path} is required.`);
  return value;
}

function requireInteger(value, path) {
  if (!Number.isInteger(value)) throw new Error(`${path} must be an integer.`);
  return value;
}

function requireCanonicalId(value, kind, providerId, path) {
  const expected = `af:${kind}:${providerId}`;
  if (value !== expected) throw new Error(`${path} must equal ${expected}.`);
}

function requireUtc(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`${path} must be a UTC ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function equalJson(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function setPath(object, path, value) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length) throw new Error('Correction field path is required.');
  let current = object;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object') throw new Error(`Correction path does not exist: ${path}`);
    current = current[part];
  }
  if (!Object.hasOwn(current, parts.at(-1))) throw new Error(`Correction path does not exist: ${path}`);
  current[parts.at(-1)] = value;
}

function validateProvenance(item, source, publishedAt, path) {
  const provenance = item?.provenance;
  if (!provenance || provenance.source !== source) throw new Error(`${path}.provenance.source must equal ${source}.`);
  if (requireUtc(provenance.fetchedAt, `${path}.provenance.fetchedAt`) !== publishedAt) {
    throw new Error(`${path}.provenance.fetchedAt must equal fixture.reconciledAt.`);
  }
  if (provenance.verification !== 'provider') throw new Error(`${path}.provenance.verification must be provider.`);
  if (!Array.isArray(provenance.issues) || provenance.issues.length) throw new Error(`${path}.provenance.issues must be empty.`);
}

function addEntity(map, entity, kind, path) {
  requireValue(entity?.id, `${path}.id`);
  requireInteger(entity?.providerId, `${path}.providerId`);
  requireCanonicalId(entity.id, kind, entity.providerId, `${path}.id`);
  requireValue(entity.name, `${path}.name`);
  const previous = map.get(entity.id);
  if (previous && (previous.providerId !== entity.providerId || previous.name !== entity.name)) {
    throw new Error(`Conflicting entity metadata for ${entity.id}.`);
  }
  map.set(entity.id, { ...previous, ...entity });
}

function validateStateMap(states, path) {
  if (!states || typeof states !== 'object' || Array.isArray(states)) throw new Error(`${path} must be an object.`);
  for (const [fieldPath, state] of Object.entries(states)) {
    if (!fieldPath || !PRESENCES.has(state?.presence)) throw new Error(`${path}.${fieldPath} has an invalid presence.`);
  }
}

function validateRawUtcTimes(bundle) {
  requireUtc(bundle?.fixture?.kickoffUtc, 'fixture.kickoffUtc');
  requireUtc(bundle?.fixture?.reconciledAt, 'fixture.reconciledAt');
  requireUtc(bundle?.fixture?.provenance?.fetchedAt, 'fixture.provenance.fetchedAt');
  for (const key of ['lineups', 'events', 'teamStats', 'playerStats']) {
    for (const [index, item] of (bundle?.[key] || []).entries()) {
      requireUtc(item?.provenance?.fetchedAt, `${key}[${index}].provenance.fetchedAt`);
    }
  }
  for (const [fieldPath, override] of Object.entries(bundle?.overrides || {})) {
    requireUtc(override?.reconciledAt, `overrides.${fieldPath}.reconciledAt`);
    if (override?.verifiedAt !== null && override?.verifiedAt !== undefined) {
      requireUtc(override.verifiedAt, `overrides.${fieldPath}.verifiedAt`);
    }
  }
}

function validateBundle(bundle, catalog = {}) {
  validateRawUtcTimes(bundle);
  if (bundle?.contractVersion !== '2.1.0') throw new Error('Fixture bundle contractVersion must be 2.1.0.');
  const normalized = normalizeFixtureBundle(bundle);
  if (normalized.contractVersion !== '2.1.0') throw new Error('Fixture bundle must normalize to contractVersion 2.1.0.');
  if (normalized.detailAvailability !== 'available') throw new Error('Only complete available fixture bundles can be imported.');
  const fixture = normalized.fixture || {};
  requireInteger(fixture.providerId, 'fixture.providerId');
  requireCanonicalId(fixture.id, 'fixture', fixture.providerId, 'fixture.id');
  requireInteger(fixture.revision, 'fixture.revision');
  if (fixture.revision < 1) throw new Error('fixture.revision must be positive.');
  const kickoffUtc = requireUtc(fixture.kickoffUtc, 'fixture.kickoffUtc');
  const publishedAt = requireUtc(fixture.reconciledAt, 'fixture.reconciledAt');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fixture.dateJst || '')) throw new Error('fixture.dateJst must be YYYY-MM-DD.');
  if (fixture.productTimeZone !== 'Asia/Tokyo') throw new Error('fixture.productTimeZone must be Asia/Tokyo.');
  if (!INGESTION_STATES.has(fixture.ingestionState)) throw new Error('fixture.ingestionState is invalid.');
  requireValue(fixture.status?.short, 'fixture.status.short');
  const source = requireValue(fixture.provenance?.source, 'fixture.provenance.source');
  validateProvenance(fixture, source, publishedAt, 'fixture');

  requireInteger(normalized.competition?.providerId, 'competition.providerId');
  requireCanonicalId(normalized.competition.id, 'competition', normalized.competition.providerId, 'competition.id');
  requireValue(normalized.competition.name, 'competition.name');
  if (fixture.competitionId !== normalized.competition.id) throw new Error('fixture.competitionId must match competition.id.');
  requireInteger(normalized.season?.providerSeason, 'season.providerSeason');
  const expectedSeasonId = `af:season:${normalized.competition.providerId}:${normalized.season.providerSeason}`;
  if (normalized.season.id !== expectedSeasonId) throw new Error(`season.id must equal ${expectedSeasonId}.`);
  if (fixture.seasonId !== normalized.season.id || normalized.season.competitionId !== normalized.competition.id) {
    throw new Error('Fixture, competition, and season IDs must be consistent.');
  }

  const productSeasonId = requireValue(catalog.productSeasonId, 'catalog.productSeasonId');
  if (!/^jfw:season:/.test(productSeasonId)) throw new Error('catalog.productSeasonId must be canonical.');
  if (!COMPETITION_TYPES.has(catalog.competition?.type)) throw new Error('catalog.competition.type must be League or Cup.');
  requireValue(catalog.season?.status, 'catalog.season.status');
  requireValue(catalog.source?.apiVersion, 'catalog.source.apiVersion');

  const teams = new Map();
  addEntity(teams, fixture.teams?.home, 'team', 'fixture.teams.home');
  addEntity(teams, fixture.teams?.away, 'team', 'fixture.teams.away');
  if (fixture.teams.home.id === fixture.teams.away.id) throw new Error('Home and away teams must differ.');

  const players = new Map();
  for (const [index, player] of (catalog.players || []).entries()) addEntity(players, player, 'player', `catalog.players[${index}]`);
  const coaches = new Map();
  const lineupPlayers = new Map();
  for (const [index, lineup] of normalized.lineups.entries()) {
    const path = `lineups[${index}]`;
    if (!teams.has(lineup.teamId)) throw new Error(`${path}.teamId must be a fixture team.`);
    if (lineup.coach) addEntity(coaches, lineup.coach, 'coach', `${path}.coach`);
    validateStateMap(lineup.fieldStates || {}, `${path}.fieldStates`);
    validateProvenance(lineup, source, publishedAt, path);
    for (const role of ['startXI', 'substitutes']) {
      if (!Array.isArray(lineup[role])) throw new Error(`${path}.${role} must be an array.`);
      for (const [playerIndex, player] of lineup[role].entries()) {
        const playerPath = `${path}.${role}[${playerIndex}]`;
        addEntity(players, player, 'player', playerPath);
        if (lineupPlayers.has(player.id)) throw new Error(`Player appears more than once in lineups: ${player.id}.`);
        lineupPlayers.set(player.id, { ...player, teamId: lineup.teamId, role: role === 'startXI' ? 'starter' : 'substitute' });
      }
    }
  }

  const playerStats = new Map();
  for (const [index, stat] of normalized.playerStats.entries()) {
    const path = `playerStats[${index}]`;
    if (stat.fixtureId !== fixture.id) throw new Error(`${path}.fixtureId must match fixture.id.`);
    if (!teams.has(stat.teamId)) throw new Error(`${path}.teamId must be a fixture team.`);
    addEntity(players, { id: stat.playerId, providerId: stat.playerProviderId, name: stat.playerName, photo: stat.playerPhoto }, 'player', path);
    if (playerStats.has(stat.playerId)) throw new Error(`Duplicate playerStats player: ${stat.playerId}.`);
    const lineupPlayer = lineupPlayers.get(stat.playerId);
    if (lineupPlayer && (lineupPlayer.teamId !== stat.teamId || lineupPlayer.position !== stat.position)) {
      throw new Error(`${path} conflicts with lineup team or position.`);
    }
    if (!stat.values || typeof stat.values !== 'object' || Array.isArray(stat.values)) throw new Error(`${path}.values must be an object.`);
    for (const [key, value] of Object.entries(stat.values)) {
      if (value === null || value === undefined) throw new Error(`${path}.values.${key} must be omitted instead of null.`);
    }
    validateStateMap(stat.fieldStates || {}, `${path}.fieldStates`);
    if (!stat.fieldIssues || typeof stat.fieldIssues !== 'object' || Array.isArray(stat.fieldIssues)) throw new Error(`${path}.fieldIssues must be an object.`);
    validateProvenance(stat, source, publishedAt, path);
    playerStats.set(stat.playerId, stat);
  }

  for (const [index, event] of normalized.events.entries()) {
    const path = `events[${index}]`;
    requireValue(event.id, `${path}.id`);
    if (!EVENT_TYPES.has(event.type)) throw new Error(`${path}.type is invalid.`);
    if (event.teamId !== null && !teams.has(event.teamId)) throw new Error(`${path}.teamId must be a fixture team or null.`);
    for (const field of ['playerId', 'relatedPlayerId']) {
      if (event[field] !== null && !players.has(event[field])) throw new Error(`${path}.${field} lacks canonical player metadata.`);
    }
    validateProvenance(event, source, publishedAt, path);
  }

  for (const [index, stat] of normalized.teamStats.entries()) {
    if (!teams.has(stat.teamId)) throw new Error(`teamStats[${index}].teamId must be a fixture team.`);
    if (!stat.values || typeof stat.values !== 'object' || Array.isArray(stat.values)) throw new Error(`teamStats[${index}].values must be an object.`);
    for (const [key, value] of Object.entries(stat.values)) {
      if (value === null || value === undefined) throw new Error(`teamStats[${index}].values.${key} must be omitted instead of null.`);
    }
    validateProvenance(stat, source, publishedAt, `teamStats[${index}]`);
  }

  for (const key of SECTION_KEYS) {
    if (!PRESENCES.has(normalized.sectionStates?.[key]?.presence)) throw new Error(`sectionStates.${key}.presence is invalid.`);
  }
  const expectedIssues = {};
  for (const [fieldPath, override] of Object.entries(normalized.overrides || {})) {
    if (!['active', 'provider_caught_up', 'review_required'].includes(override?.status)) throw new Error(`Override status is invalid: ${fieldPath}.`);
    requireUtc(override.reconciledAt, `overrides.${fieldPath}.reconciledAt`);
    if (override.status === 'review_required') expectedIssues[fieldPath] = ['conflict'];
  }
  if (Object.keys(expectedIssues).length && fixture.ingestionState !== 'needs_review') {
    throw new Error('review_required corrections require fixture.ingestionState needs_review.');
  }
  if (!equalJson(normalized.fieldIssues || {}, expectedIssues)) {
    throw new Error('Top-level fieldIssues must exactly represent review_required corrections.');
  }
  return { normalized, fixture, kickoffUtc, publishedAt, productSeasonId, source, teams, players, coaches, playerStats };
}

function upsertMasterData(database, context, catalog) {
  const { normalized, productSeasonId, source, teams, players, coaches } = context;
  run(database, `INSERT INTO provider_sources(code, api_version) VALUES (?1, ?2)
    ON CONFLICT(code) DO UPDATE SET api_version = excluded.api_version`, source, catalog.source.apiVersion);
  const sourceRow = row(database, 'SELECT id FROM provider_sources WHERE code = ?1', source);
  const productSeason = row(database, 'SELECT id FROM product_seasons WHERE canonical_id = ?1', productSeasonId);
  if (!productSeason) throw new Error(`Product season does not exist: ${productSeasonId}.`);
  run(database, `INSERT INTO competitions(
      canonical_id, source_id, provider_id, name, country_code, country_name, type, logo_url, flag_url
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(canonical_id) DO UPDATE SET
      name = excluded.name, country_code = excluded.country_code, country_name = excluded.country_name,
      type = excluded.type, logo_url = excluded.logo_url, flag_url = excluded.flag_url`,
  normalized.competition.id, sourceRow.id, normalized.competition.providerId, normalized.competition.name,
  catalog.competition.countryCode || null, normalized.competition.country, catalog.competition.type,
  normalized.competition.logo, normalized.competition.flag);
  const competition = row(database, `SELECT id, source_id, provider_id FROM competitions
    WHERE canonical_id = ?1`, normalized.competition.id);
  assertProviderIdentity(competition, normalized.competition.providerId, sourceRow.id, 'competition');
  run(database, `INSERT INTO competition_seasons(
      canonical_id, competition_id, product_season_id, provider_season, label, starts_on, ends_on, finalized_on, status
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(canonical_id) DO UPDATE SET product_season_id = excluded.product_season_id,
      label = excluded.label, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
      finalized_on = excluded.finalized_on, status = excluded.status`,
  normalized.season.id, competition.id, productSeason.id, normalized.season.providerSeason, normalized.season.label,
  catalog.season.startsOn || null, catalog.season.endsOn || null, catalog.season.finalizedOn || null, catalog.season.status);
  const season = row(database, `SELECT id, competition_id, provider_season FROM competition_seasons
    WHERE canonical_id = ?1`, normalized.season.id);
  if (season.competition_id !== competition.id || season.provider_season !== normalized.season.providerSeason) {
    throw new Error('season conflicts with existing competition/provider identity.');
  }

  for (const team of teams.values()) {
    run(database, `INSERT INTO teams(canonical_id, source_id, provider_id, name, code, logo_url)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(canonical_id) DO UPDATE SET name = excluded.name,
        code = COALESCE(excluded.code, teams.code), logo_url = excluded.logo_url`,
    team.id, sourceRow.id, team.providerId, team.name, team.code || null, team.logo || null);
    const teamRow = row(database, `SELECT id, source_id, provider_id FROM teams
      WHERE canonical_id = ?1`, team.id);
    assertProviderIdentity(teamRow, team.providerId, sourceRow.id, `team ${team.id}`);
    run(database, `INSERT INTO competition_season_teams(competition_season_id, team_id)
      VALUES (?1, ?2) ON CONFLICT DO NOTHING`, season.id, teamRow.id);
  }
  for (const player of players.values()) {
    run(database, `INSERT INTO players(canonical_id, source_id, provider_id, display_name, nationality, birth_date, photo_url)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(canonical_id) DO UPDATE SET display_name = excluded.display_name,
        nationality = COALESCE(excluded.nationality, players.nationality),
        birth_date = COALESCE(excluded.birth_date, players.birth_date),
        photo_url = COALESCE(excluded.photo_url, players.photo_url)`,
    player.id, sourceRow.id, player.providerId, player.name, player.nationality || null,
    player.birthDate || null, player.photo || null);
    const playerRow = row(database, `SELECT source_id, provider_id FROM players
      WHERE canonical_id = ?1`, player.id);
    assertProviderIdentity(playerRow, player.providerId, sourceRow.id, `player ${player.id}`);
  }
  for (const coach of coaches.values()) {
    run(database, `INSERT INTO coaches(canonical_id, source_id, provider_id, display_name, photo_url)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(canonical_id) DO UPDATE SET display_name = excluded.display_name,
        photo_url = COALESCE(excluded.photo_url, coaches.photo_url)`,
    coach.id, sourceRow.id, coach.providerId, coach.name, coach.photo || null);
    const coachRow = row(database, `SELECT source_id, provider_id FROM coaches
      WHERE canonical_id = ?1`, coach.id);
    assertProviderIdentity(coachRow, coach.providerId, sourceRow.id, `coach ${coach.id}`);
  }

  let venue = null;
  if (normalized.fixture.venue?.id !== null) {
    const item = normalized.fixture.venue;
    requireInteger(item.providerId, 'fixture.venue.providerId');
    requireCanonicalId(item.id, 'venue', item.providerId, 'fixture.venue.id');
    requireValue(item.name, 'fixture.venue.name');
    run(database, `INSERT INTO venues(canonical_id, source_id, provider_id, name, city)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(canonical_id) DO UPDATE SET name = excluded.name, city = excluded.city`,
    item.id, sourceRow.id, item.providerId, item.name, item.city);
    venue = row(database, `SELECT id, source_id, provider_id FROM venues
      WHERE canonical_id = ?1`, item.id);
    assertProviderIdentity(venue, item.providerId, sourceRow.id, `venue ${item.id}`);
  } else if (!equalJson(normalized.fixture.venue, { id: null, providerId: null, name: null, city: null })) {
    throw new Error('A missing venue must contain only null canonical fields.');
  }
  return { season, sourceRow, venue };
}

function correctionDefinitions(bundle) {
  return Object.entries(bundle.overrides || {}).map(([fieldPath, override]) => ({
    correctionKey: `${bundle.fixture.id}:${fieldPath}`,
    fieldPath,
    reason: override.reason ?? null,
    sourceUrl: override.sourceUrl ?? null,
    verifiedAt: override.verifiedAt ?? null,
  }));
}

function validateCorrectionDefinitions(document, fixtureId) {
  const errors = [];
  if (document?.schemaVersion !== CORRECTION_DEFINITIONS_SCHEMA_VERSION) {
    errors.push('unsupported correction definitions schemaVersion');
  }
  if (document?.fixtureId !== fixtureId) errors.push('correction definitions fixtureId mismatch');
  if (!Array.isArray(document?.definitions)) {
    errors.push('correction definitions must be an array');
    return errors;
  }
  const keys = new Set();
  for (const [index, definition] of document.definitions.entries()) {
    if (definition?.correctionKey !== `${fixtureId}:${definition?.fieldPath || ''}`) {
      errors.push(`definitions[${index}].correctionKey must derive from fixtureId and fieldPath`);
    }
    if (!definition?.fieldPath) errors.push(`definitions[${index}].fieldPath is required`);
    if (keys.has(definition?.correctionKey)) {
      errors.push(`duplicate correctionKey: ${definition.correctionKey}`);
    }
    keys.add(definition?.correctionKey);
  }
  return errors;
}

function assertCorrectionDefinitions(bundle, document) {
  const fixtureId = bundle?.fixture?.id;
  const errors = validateCorrectionDefinitions(document, fixtureId);
  if (errors.length) throw new Error(`Invalid correction definitions:\n- ${errors.join('\n- ')}`);
  const declared = [...document.definitions]
    .sort((left, right) => left.correctionKey.localeCompare(right.correctionKey));
  const authored = correctionDefinitions(bundle)
    .sort((left, right) => left.correctionKey.localeCompare(right.correctionKey));
  if (stableStringify(declared) !== stableStringify(authored)) {
    throw new Error('Git correction definitions must exactly match the fixture bundle overrides.');
  }
}

function importFixtureBundle(database, bundle, catalog = {}, correctionDocument) {
  if (!database || typeof database.prepare !== 'function') throw new TypeError('A node:sqlite DatabaseSync instance is required.');
  const context = validateBundle(bundle, catalog);
  const { normalized, fixture, kickoffUtc, publishedAt, playerStats } = context;
  assertCorrectionDefinitions(normalized, correctionDocument);
  const contentSha256 = sha256(normalized);
  const definitions = correctionDefinitions(normalized);
  const current = row(database, `SELECT revision.content_sha256, revision.revision_no
    FROM fixtures fixture JOIN fixture_revisions revision ON revision.id = fixture.published_revision
    WHERE fixture.canonical_id = ?1`, fixture.id);
  if (current?.content_sha256 === contentSha256) {
    if (current.revision_no !== fixture.revision) throw new Error('Existing content hash has a different fixture revision.');
    return { fixtureId: fixture.id, contentSha256, imported: false, reason: 'already_published', correctionDefinitions: definitions };
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    const master = upsertMasterData(database, context, catalog);
    const homeTeam = row(database, 'SELECT id FROM teams WHERE canonical_id = ?1', fixture.teams.home.id);
    const awayTeam = row(database, 'SELECT id FROM teams WHERE canonical_id = ?1', fixture.teams.away.id);
    const existingFixture = row(database, 'SELECT id, published_revision FROM fixtures WHERE canonical_id = ?1', fixture.id);
    const previousRevisionId = existingFixture?.published_revision || null;
    const baseBundle = JSON.parse(JSON.stringify(normalized));
    run(database, 'DELETE FROM correction_states WHERE target_canonical_id = ?1', fixture.id);
    for (const [fieldPath, override] of Object.entries(normalized.overrides || {})) {
      if (override.status === 'active') setPath(baseBundle, fieldPath, override.correctedProviderValue);
    }
    const base = baseBundle.fixture;
    if (existingFixture) {
      if (previousRevisionId) {
        run(database, 'UPDATE fixtures SET published_revision = NULL WHERE id = ?1', existingFixture.id);
        run(database, `UPDATE fixture_revisions SET lifecycle_state = 'superseded'
          WHERE id = ?1 AND lifecycle_state = 'published'`, previousRevisionId);
      }
      run(database, `UPDATE fixtures SET source_id = ?1, provider_id = ?2, competition_season_id = ?3,
        venue_id = ?4, home_team_id = ?5, away_team_id = ?6, kickoff_utc = ?7, date_jst = ?8,
        round = ?9, referee = ?10, status_short = ?11, status_long = ?12, status_elapsed = ?13,
        home_goals = ?14, away_goals = ?15, home_winner = ?16, away_winner = ?17, ingestion_state = ?18
        WHERE id = ?19`, master.sourceRow.id, fixture.providerId, master.season.id, master.venue?.id || null,
      homeTeam.id, awayTeam.id, kickoffUtc, fixture.dateJst, fixture.round, fixture.referee,
      fixture.status.short, fixture.status.long, fixture.status.elapsed, base.score.goals.home, base.score.goals.away,
      base.teams.home.winner === null ? null : Number(base.teams.home.winner),
      base.teams.away.winner === null ? null : Number(base.teams.away.winner), base.ingestionState, existingFixture.id);
    } else {
      run(database, `INSERT INTO fixtures(
        canonical_id, source_id, provider_id, competition_season_id, venue_id, home_team_id, away_team_id,
        kickoff_utc, date_jst, round, referee, status_short, status_long, status_elapsed,
        home_goals, away_goals, home_winner, away_winner, ingestion_state
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
      fixture.id, master.sourceRow.id, fixture.providerId, master.season.id, master.venue?.id || null,
      homeTeam.id, awayTeam.id, kickoffUtc, fixture.dateJst, fixture.round, fixture.referee,
      fixture.status.short, fixture.status.long, fixture.status.elapsed, base.score.goals.home, base.score.goals.away,
      base.teams.home.winner === null ? null : Number(base.teams.home.winner),
      base.teams.away.winner === null ? null : Number(base.teams.away.winner), base.ingestionState);
    }
    const fixtureRow = row(database, 'SELECT id FROM fixtures WHERE canonical_id = ?1', fixture.id);
    const nextRevision = row(database, `SELECT COALESCE(MAX(revision_no), 0) + 1 AS revision_no
      FROM fixture_revisions WHERE fixture_id = ?1`, fixtureRow.id).revision_no;
    if (fixture.revision !== nextRevision) throw new Error(`fixture.revision must be the next revision (${nextRevision}).`);
    run(database, `INSERT INTO fixture_revisions(
      fixture_id, revision_no, lifecycle_state, detail_location, content_sha256, created_at, published_at
    ) VALUES (?1, ?2, 'staging', 'd1', ?3, ?4, NULL)`, fixtureRow.id, fixture.revision, contentSha256, publishedAt);
    const revision = row(database, 'SELECT last_insert_rowid() AS id');

    run(database, 'DELETE FROM fixture_score_parts WHERE fixture_id = ?1', fixtureRow.id);
    for (const kind of SCORE_KINDS) {
      const score = base.score[kind];
      run(database, `INSERT INTO fixture_score_parts(fixture_id, score_kind, home_value, away_value)
        VALUES (?1, ?2, ?3, ?4)`, fixtureRow.id, kind, score.home, score.away);
    }

    const lineupPlayers = new Map();
    for (const lineup of normalized.lineups) {
      const team = row(database, 'SELECT id FROM teams WHERE canonical_id = ?1', lineup.teamId);
      const coach = lineup.coach ? row(database, 'SELECT id FROM coaches WHERE canonical_id = ?1', lineup.coach.id) : null;
      run(database, `INSERT INTO fixture_lineups(fixture_revision_id, team_id, coach_id, formation)
        VALUES (?1, ?2, ?3, ?4)`, revision.id, team.id, coach?.id || null, lineup.formation);
      const lineupRow = row(database, 'SELECT last_insert_rowid() AS id');
      for (const [role, entries] of [['starter', lineup.startXI], ['substitute', lineup.substitutes]]) {
        for (const [entryOrder, player] of entries.entries()) {
          lineupPlayers.set(player.id, { ...player, teamId: lineup.teamId, role,
            entryOrder, lineupId: lineupRow.id });
        }
      }
      for (const [fieldPath, state] of Object.entries(lineup.fieldStates || {})) {
        run(database, `INSERT INTO field_states(
          fixture_revision_id, fact_kind, fact_key, field_path, presence, issue_flags_json
        ) VALUES (?1, 'lineup', ?2, ?3, ?4, '[]')`, revision.id, lineup.teamId, fieldPath, state.presence);
      }
    }

    const appearancePlayers = new Set([...lineupPlayers.keys(), ...playerStats.keys()]);
    for (const playerId of appearancePlayers) {
      const lineupPlayer = lineupPlayers.get(playerId);
      const stat = playerStats.get(playerId);
      const teamId = stat?.teamId || lineupPlayer.teamId;
      const team = row(database, 'SELECT id FROM teams WHERE canonical_id = ?1', teamId);
      const player = row(database, 'SELECT id FROM players WHERE canonical_id = ?1', playerId);
      run(database, `INSERT INTO fixture_player_records(fixture_id, team_id, player_id, kickoff_utc)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(fixture_id, player_id) DO UPDATE SET kickoff_utc = excluded.kickoff_utc`,
      fixtureRow.id, team.id, player.id, kickoffUtc);
      const record = row(database, `SELECT id, team_id FROM fixture_player_records
        WHERE fixture_id = ?1 AND player_id = ?2`, fixtureRow.id, player.id);
      if (record.team_id !== team.id) throw new Error(`Existing player record has a different team: ${playerId}.`);
      const starter = stat?.starter;
      const appearanceState = starter === true ? 'started'
        : (starter === false && (stat.values.minutes || 0) > 0 ? 'substitute_used'
          : (starter === false ? 'bench_unused' : 'unknown'));
      run(database, `INSERT INTO fixture_player_appearances(
        fixture_revision_id, player_record_id, appearance_state, position, minutes, captain
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`, revision.id, record.id, appearanceState,
      stat?.position ?? lineupPlayer?.position ?? null, stat?.values?.minutes ?? null,
      stat?.captain === null || stat?.captain === undefined ? null : Number(stat.captain));
      const appearance = row(database, 'SELECT last_insert_rowid() AS id');
      if (lineupPlayer) {
        run(database, `INSERT INTO fixture_lineup_entries(
          lineup_id, player_appearance_id, squad_role, entry_order, shirt_number, grid
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`, lineupPlayer.lineupId, appearance.id,
        lineupPlayer.role, lineupPlayer.entryOrder, lineupPlayer.number, lineupPlayer.grid);
      }
      if (stat) {
        const knownKeys = Object.keys(PLAYER_STAT_COLUMNS);
        const columns = knownKeys.map(key => PLAYER_STAT_COLUMNS[key]);
        const extra = Object.fromEntries(Object.entries(stat.values).filter(([key]) => !PLAYER_STAT_COLUMNS[key]));
        const placeholders = columns.map((_, index) => `?${index + 2}`).join(', ');
        run(database, `INSERT INTO fixture_player_stats(
          player_appearance_id, ${columns.join(', ')}, extra_stats_json
        ) VALUES (?1, ${placeholders}, ?${columns.length + 2})`, appearance.id,
        ...knownKeys.map(key => Object.hasOwn(stat.values, key) ? stat.values[key] : null),
        Object.keys(extra).length ? JSON.stringify(extra) : null);
        for (const [fieldPath, state] of Object.entries(stat.fieldStates || {})) {
          run(database, `INSERT INTO field_states(
            fixture_revision_id, fact_kind, fact_key, field_path, presence, issue_flags_json
          ) VALUES (?1, 'player_stat', ?2, ?3, ?4, ?5)`, revision.id, playerId, fieldPath,
          state.presence, JSON.stringify(stat.fieldIssues?.[fieldPath] || []));
        }
        for (const fieldPath of Object.keys(stat.fieldIssues || {})) {
          if (!Object.hasOwn(stat.fieldStates || {}, fieldPath)) throw new Error(`playerStats field issue lacks field state: ${playerId}:${fieldPath}.`);
        }
      }
    }

    const eventIds = new Set();
    for (const [index, event] of normalized.events.entries()) {
      if (eventIds.has(event.id)) throw new Error(`Duplicate event ID: ${event.id}.`);
      eventIds.add(event.id);
      const team = event.teamId ? row(database, 'SELECT id FROM teams WHERE canonical_id = ?1', event.teamId) : null;
      const player = event.playerId ? row(database, 'SELECT id FROM players WHERE canonical_id = ?1', event.playerId) : null;
      const related = event.relatedPlayerId ? row(database, 'SELECT id FROM players WHERE canonical_id = ?1', event.relatedPlayerId) : null;
      run(database, `INSERT INTO fixture_events(
        fixture_revision_id, event_key, team_id, player_id, related_player_id, elapsed,
        extra_minute, event_order, type, detail, comments
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      revision.id, event.id, team?.id || null, player?.id || null, related?.id || null,
      event.elapsed, event.extra, index, event.type, event.detail, event.comments);
    }
    for (const stat of normalized.teamStats) {
      const team = row(database, 'SELECT id FROM teams WHERE canonical_id = ?1', stat.teamId);
      const keys = Object.keys(TEAM_STAT_COLUMNS);
      const columns = keys.map(key => TEAM_STAT_COLUMNS[key]);
      const extra = Object.fromEntries(Object.entries(stat.values).filter(([key]) => !TEAM_STAT_COLUMNS[key]));
      const placeholders = columns.map((_, index) => `?${index + 3}`).join(', ');
      run(database, `INSERT INTO fixture_team_stats(
        fixture_revision_id, team_id, ${columns.join(', ')}, extra_stats_json
      ) VALUES (?1, ?2, ${placeholders}, ?${columns.length + 3})`, revision.id, team.id,
      ...keys.map(key => Object.hasOwn(stat.values, key) ? stat.values[key] : null),
      Object.keys(extra).length ? JSON.stringify(extra) : null);
    }
    for (const key of SECTION_KEYS) {
      const state = normalized.sectionStates[key].presence;
      const stored = state === 'present' && normalized[key].length === 0 ? 'present_empty' : state;
      run(database, `INSERT INTO section_states(fixture_revision_id, section_key, presence, observed_at)
        VALUES (?1, ?2, ?3, ?4)`, revision.id, key, stored, publishedAt);
    }
    for (const [fieldPath, override] of Object.entries(normalized.overrides || {})) {
      const correctionKey = `${fixture.id}:${fieldPath}`;
      run(database, `INSERT INTO correction_states(
        correction_key, target_kind, target_canonical_id, field_path, status,
        provider_baseline_json, applied_value_json, reason, source_url, verified_at, reconciled_at
      ) VALUES (?1, 'fixture', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(correction_key) DO UPDATE SET status = excluded.status,
        provider_baseline_json = excluded.provider_baseline_json,
        applied_value_json = excluded.applied_value_json, reason = excluded.reason,
        source_url = excluded.source_url, verified_at = excluded.verified_at,
        reconciled_at = excluded.reconciled_at`,
      correctionKey, fixture.id, fieldPath, override.status,
      JSON.stringify(override.correctedProviderValue), JSON.stringify(override.value),
      override.reason ?? null, override.sourceUrl ?? null, override.verifiedAt ?? null,
      override.reconciledAt);
    }
    run(database, `UPDATE fixture_revisions SET lifecycle_state = 'published', published_at = ?1 WHERE id = ?2`, publishedAt, revision.id);
    run(database, 'UPDATE fixtures SET published_revision = ?1 WHERE id = ?2', revision.id, fixtureRow.id);
    if (previousRevisionId) {
      for (const table of ['fixture_events', 'fixture_lineups', 'fixture_player_appearances', 'fixture_team_stats', 'section_states', 'field_states']) {
        run(database, `DELETE FROM ${table} WHERE fixture_revision_id = ?1`, previousRevisionId);
      }
    }
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) throw new Error(`Fixture import failed foreign key validation for ${foreignKeys.length} row(s).`);
    database.exec('COMMIT');
    return {
      fixtureId: fixture.id, contentSha256, imported: true, revision: fixture.revision,
      correctionDefinitions: definitions,
      counts: { events: normalized.events.length, lineups: normalized.lineups.length,
        playerStats: normalized.playerStats.length, teamStats: normalized.teamStats.length },
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  CORRECTION_DEFINITIONS_SCHEMA_VERSION,
  PLAYER_STAT_COLUMNS,
  TEAM_STAT_COLUMNS,
  assertCorrectionDefinitions,
  correctionDefinitions,
  importFixtureBundle,
  validateCorrectionDefinitions,
  validateBundle,
};
