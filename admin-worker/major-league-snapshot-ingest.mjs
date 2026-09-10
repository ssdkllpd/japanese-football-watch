import { assertValidStandingsPayload } from '../shared/standings-contract.mjs';

export const MAJOR_LEAGUE_CORE_OPERATION = 'major_league_core_publish';
export const MAJOR_LEAGUE_STANDINGS_OPERATION = 'major_league_standings_publish';
export const MAJOR_LEAGUE_CORE_SCHEMA = 'jfw-d1-major-league-core-artifact/1';

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_TEAMS = 100;
const MAX_VENUES = 150;
const MAX_FIXTURES = 1_000;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function fields(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}.`);
}

function canonical(value, expression, label) {
  if (typeof value !== 'string' || !expression.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function realDate(value, label) {
  canonical(value, /^\d{4}-\d{2}-\d{2}$/, label);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a real date.`);
  }
  return value;
}

function instant(value, label) {
  canonical(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, label);
  if (new Date(value).toISOString() !== value) throw new Error(`${label} is not a canonical UTC instant.`);
  return value;
}

function nullableInteger(value, label) {
  if (value !== null) integer(value, label);
}

function nullableText(value, label) {
  if (value !== null && typeof value !== 'string') throw new Error(`${label} must be a string or null.`);
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates.`);
}

function canonicalProvider(value, prefix, label) {
  const match = new RegExp(`^af:${prefix}:(\\d+)$`).exec(String(value || ''));
  if (!match) throw new Error(`${label} is invalid.`);
  return Number(match[1]);
}

function sourceRequestFields() {
  return new Set([
    'schemaVersion', 'operation', 'competitionId', 'seasonId', 'snapshotId',
    'archiveSha256', 'artifactKey', 'artifactSha256',
  ]);
}

export function assertMajorLeagueSnapshotRequest(input) {
  fields(input, sourceRequestFields(), 'Major-league snapshot request');
  if (![MAJOR_LEAGUE_CORE_OPERATION, MAJOR_LEAGUE_STANDINGS_OPERATION].includes(input.operation)) {
    throw new Error('Major-league snapshot operation is invalid.');
  }
  const competitionProviderId = canonicalProvider(input.competitionId, 'competition', 'competitionId');
  const season = /^af:season:(\d+):(\d+)$/.exec(String(input.seasonId || ''));
  if (!season || Number(season[1]) !== competitionProviderId || Number(season[2]) !== 2026) {
    throw new Error('Major-league snapshot season scope is invalid.');
  }
  canonical(input.snapshotId, /^\d{8}-\d{9}Z$/, 'snapshotId');
  canonical(input.archiveSha256, /^[0-9a-f]{64}$/, 'archiveSha256');
  canonical(input.artifactSha256, /^[0-9a-f]{64}$/, 'artifactSha256');
  const expectedKey = `migration/api-football/v3/major-leagues/2026/${input.archiveSha256}`
    + `/leagues/${competitionProviderId}/core-${input.artifactSha256}.json`;
  if (input.artifactKey !== expectedKey) throw new Error('Major-league snapshot artifact key is not content-addressed in the reviewed migration prefix.');
  return input;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateEntity(entity, kind, label) {
  fields(entity, new Set(kind === 'team'
    ? ['id', 'providerId', 'name', 'code', 'logo']
    : ['id', 'providerId', 'name', 'city']), label);
  const providerId = canonicalProvider(entity.id, kind, `${label}.id`);
  if (entity.providerId !== providerId) throw new Error(`${label}.providerId does not match its canonical ID.`);
  if (typeof entity.name !== 'string' || !entity.name) throw new Error(`${label}.name is required.`);
  if (kind === 'team') {
    nullableText(entity.code, `${label}.code`);
    nullableText(entity.logo, `${label}.logo`);
  } else nullableText(entity.city, `${label}.city`);
}

function validateScorePair(value, label) {
  fields(value, new Set(['home', 'away']), label);
  nullableInteger(value.home, `${label}.home`);
  nullableInteger(value.away, `${label}.away`);
}

function validateFixture(fixture, artifact, teamIds, venueIds, index) {
  const label = `core.fixtures[${index}]`;
  fields(fixture, new Set([
    'fixtureId', 'providerId', 'competitionId', 'seasonId', 'kickoffUtc', 'dateJst',
    'round', 'referee', 'venue', 'status', 'ingestionState', 'teams', 'score',
  ]), label);
  const providerId = canonicalProvider(fixture.fixtureId, 'fixture', `${label}.fixtureId`);
  if (fixture.providerId !== providerId || fixture.competitionId !== artifact.competition.id
    || fixture.seasonId !== artifact.season.id) throw new Error(`${label} scope is inconsistent.`);
  instant(fixture.kickoffUtc, `${label}.kickoffUtc`);
  realDate(fixture.dateJst, `${label}.dateJst`);
  const expectedJst = new Date(new Date(fixture.kickoffUtc).getTime() + 9 * 60 * 60 * 1_000)
    .toISOString().slice(0, 10);
  if (fixture.dateJst !== expectedJst) throw new Error(`${label}.dateJst does not match kickoffUtc.`);
  nullableText(fixture.round, `${label}.round`);
  nullableText(fixture.referee, `${label}.referee`);
  fields(fixture.venue, new Set(['id', 'providerId', 'name', 'city']), `${label}.venue`);
  if (fixture.venue.id === null) {
    if (fixture.venue.providerId !== null) throw new Error(`${label}.venue provider identity is inconsistent.`);
  } else if (!venueIds.has(fixture.venue.id)
    || canonicalProvider(fixture.venue.id, 'venue', `${label}.venue.id`) !== fixture.venue.providerId) {
    throw new Error(`${label}.venue is outside the artifact catalog.`);
  }
  fields(fixture.status, new Set(['short', 'long', 'elapsed']), `${label}.status`);
  if (typeof fixture.status.short !== 'string' || !fixture.status.short) throw new Error(`${label}.status.short is required.`);
  nullableText(fixture.status.long, `${label}.status.long`);
  nullableInteger(fixture.status.elapsed, `${label}.status.elapsed`);
  if (!new Set(['scheduled', 'live', 'provisional_final', 'finalized', 'needs_review']).has(fixture.ingestionState)) {
    throw new Error(`${label}.ingestionState is invalid.`);
  }
  fields(fixture.teams, new Set(['home', 'away']), `${label}.teams`);
  for (const side of ['home', 'away']) {
    const team = fixture.teams[side];
    fields(team, new Set(['id', 'providerId', 'name', 'logo', 'winner']), `${label}.teams.${side}`);
    if (!teamIds.has(team.id) || canonicalProvider(team.id, 'team', `${label}.teams.${side}.id`) !== team.providerId) {
      throw new Error(`${label}.teams.${side} is outside the artifact catalog.`);
    }
    nullableText(team.name, `${label}.teams.${side}.name`);
    nullableText(team.logo, `${label}.teams.${side}.logo`);
    if (team.winner !== null && typeof team.winner !== 'boolean') throw new Error(`${label}.teams.${side}.winner is invalid.`);
  }
  if (fixture.teams.home.id === fixture.teams.away.id) throw new Error(`${label} has the same home and away team.`);
  fields(fixture.score, new Set(['goals', 'halftime', 'fulltime', 'extratime', 'penalty']), `${label}.score`);
  for (const key of ['goals', 'halftime', 'fulltime', 'extratime', 'penalty']) {
    validateScorePair(fixture.score[key], `${label}.score.${key}`);
  }
}

export function assertMajorLeagueCoreArtifact(artifact, input) {
  fields(artifact, new Set([
    'schemaVersion', 'source', 'productSeason', 'competition', 'season',
    'teams', 'venues', 'fixtures', 'standings',
  ]), 'core artifact');
  if (artifact.schemaVersion !== MAJOR_LEAGUE_CORE_SCHEMA) throw new Error('Major-league core artifact schema is invalid.');
  fields(artifact.source, new Set([
    'provider', 'apiVersion', 'snapshotId', 'archiveKey', 'archiveSha256',
    'archiveByteSize', 'observedAt',
  ]), 'core.source');
  if (artifact.source.provider !== 'api-football' || artifact.source.apiVersion !== 'v3'
    || artifact.source.snapshotId !== input.snapshotId
    || artifact.source.archiveSha256 !== input.archiveSha256) throw new Error('Major-league core source does not match the declared snapshot.');
  const expectedArchiveKey = `audit/api-football/v3/major-leagues/2026/snapshots/${input.snapshotId}.tar.gz`;
  if (artifact.source.archiveKey !== expectedArchiveKey) throw new Error('Major-league core archive key is invalid.');
  integer(artifact.source.archiveByteSize, 'core.source.archiveByteSize');
  instant(artifact.source.observedAt, 'core.source.observedAt');

  fields(artifact.productSeason, new Set(['id', 'label', 'startsOn', 'endsOn']), 'core.productSeason');
  canonical(artifact.productSeason.id, /^jfw:season:2026-27$/, 'core.productSeason.id');
  if (typeof artifact.productSeason.label !== 'string' || !artifact.productSeason.label) throw new Error('core.productSeason.label is required.');
  realDate(artifact.productSeason.startsOn, 'core.productSeason.startsOn');
  realDate(artifact.productSeason.endsOn, 'core.productSeason.endsOn');

  fields(artifact.competition, new Set(['id', 'providerId', 'name', 'country', 'logo', 'flag', 'type']), 'core.competition');
  if (artifact.competition.id !== input.competitionId
    || artifact.competition.providerId !== canonicalProvider(
      input.competitionId, 'competition', 'competitionId',
    )) throw new Error('Major-league core competition identity is inconsistent.');
  if (!artifact.competition.name || !artifact.competition.country
    || !['League', 'Cup'].includes(artifact.competition.type)) throw new Error('Major-league core competition metadata is invalid.');
  nullableText(artifact.competition.logo, 'core.competition.logo');
  nullableText(artifact.competition.flag, 'core.competition.flag');

  fields(artifact.season, new Set([
    'id', 'competitionId', 'providerSeason', 'label', 'startsOn', 'endsOn', 'status',
  ]), 'core.season');
  if (artifact.season.id !== input.seasonId || artifact.season.competitionId !== input.competitionId
    || artifact.season.providerSeason !== 2026) throw new Error('Major-league core season identity is inconsistent.');
  realDate(artifact.season.startsOn, 'core.season.startsOn');
  realDate(artifact.season.endsOn, 'core.season.endsOn');
  if (!artifact.season.startsOn.startsWith('2026-') || !artifact.season.endsOn.startsWith('2027-')) {
    throw new Error('Major-league core season boundary gate failed.');
  }
  if (typeof artifact.season.label !== 'string' || !artifact.season.label
    || typeof artifact.season.status !== 'string' || !artifact.season.status) {
    throw new Error('Major-league core season metadata is invalid.');
  }
  if (!Array.isArray(artifact.teams) || artifact.teams.length === 0 || artifact.teams.length > MAX_TEAMS) {
    throw new Error('Major-league core teams exceed their bounds.');
  }
  if (!Array.isArray(artifact.venues) || artifact.venues.length > MAX_VENUES) throw new Error('Major-league core venues exceed their bounds.');
  if (!Array.isArray(artifact.fixtures) || artifact.fixtures.length === 0 || artifact.fixtures.length > MAX_FIXTURES) {
    throw new Error('Major-league core fixtures exceed their bounds.');
  }
  artifact.teams.forEach((team, index) => validateEntity(team, 'team', `core.teams[${index}]`));
  artifact.venues.forEach((venue, index) => validateEntity(venue, 'venue', `core.venues[${index}]`));
  unique(artifact.teams.map(team => team.id), 'core.teams');
  unique(artifact.teams.map(team => team.providerId), 'core.teams provider IDs');
  unique(artifact.venues.map(venue => venue.id), 'core.venues');
  unique(artifact.venues.map(venue => venue.providerId), 'core.venues provider IDs');
  const teamIds = new Set(artifact.teams.map(team => team.id));
  const venueIds = new Set(artifact.venues.map(venue => venue.id));
  artifact.fixtures.forEach((fixture, index) => validateFixture(fixture, artifact, teamIds, venueIds, index));
  unique(artifact.fixtures.map(fixture => fixture.fixtureId), 'core.fixtures');
  unique(artifact.fixtures.map(fixture => fixture.providerId), 'core.fixtures provider IDs');
  assertValidStandingsPayload(artifact.standings, {
    expectedCompetitionId: input.competitionId,
    expectedSeasonId: input.seasonId,
  });
  const standingsTeams = artifact.standings.groups.flatMap(group => group.table.map(row => row.team.id));
  if (standingsTeams.some(teamId => !teamIds.has(teamId))) throw new Error('Major-league standings references a team outside the core catalog.');
  return artifact;
}

async function readArtifact(env, request) {
  if (!env.FOOTBALL_DB || !env.FOOTBALL_DATA) throw new Error('Admin ingest bindings are unavailable.');
  const input = assertMajorLeagueSnapshotRequest(request);
  const object = await env.FOOTBALL_DATA.get(input.artifactKey);
  if (!object) {
    const error = new Error('Major-league migration artifact is missing.');
    error.status = 404;
    throw error;
  }
  const raw = await object.text();
  const byteSize = new TextEncoder().encode(raw).byteLength;
  if (byteSize > MAX_ARTIFACT_BYTES) throw new Error('Major-league migration artifact exceeds the ingest limit.');
  if (await sha256(raw) !== input.artifactSha256) throw new Error('Major-league migration artifact hash mismatch.');
  let artifact;
  try { artifact = JSON.parse(raw); } catch { throw new Error('Major-league migration artifact is not JSON.'); }
  assertMajorLeagueCoreArtifact(artifact, input);
  return { input, artifact, raw, byteSize };
}

function statement(database, sql, params = []) {
  return database.prepare(sql).bind(...params);
}

async function rows(database, sql, params = []) {
  const result = await database.prepare(sql).bind(...params).all();
  return result.results || [];
}

async function assertStoredIdentity(database, artifact) {
  const productSeasonRows = await rows(database, `
    SELECT canonical_id, label, starts_on, ends_on
    FROM product_seasons WHERE canonical_id = ?
  `, [artifact.productSeason.id]);
  if (productSeasonRows.some(row => row.canonical_id !== artifact.productSeason.id
    || row.starts_on !== artifact.productSeason.startsOn
    || row.ends_on !== artifact.productSeason.endsOn)) {
    throw new Error('Stored product-season boundary differs.');
  }
  const competitionRows = await rows(database, `
    SELECT competition.canonical_id, competition.provider_id, source.code, source.api_version
    FROM competitions competition JOIN provider_sources source ON source.id = competition.source_id
    WHERE competition.canonical_id = ? OR (source.code = 'api-football' AND competition.provider_id = ?)
  `, [artifact.competition.id, artifact.competition.providerId]);
  if (competitionRows.some(row => row.canonical_id !== artifact.competition.id
    || row.provider_id !== artifact.competition.providerId || row.code !== 'api-football'
    || row.api_version !== 'v3')) throw new Error('Stored competition provider identity differs.');
  const seasonRows = await rows(database, `
    SELECT season.canonical_id, season.provider_season, competition.canonical_id AS competition_id
    FROM competition_seasons season JOIN competitions competition ON competition.id = season.competition_id
    WHERE season.canonical_id = ? OR (competition.canonical_id = ? AND season.provider_season = ?)
  `, [artifact.season.id, artifact.competition.id, artifact.season.providerSeason]);
  if (seasonRows.some(row => row.canonical_id !== artifact.season.id
    || row.provider_season !== artifact.season.providerSeason
    || row.competition_id !== artifact.competition.id)) throw new Error('Stored competition-season identity differs.');
}

function coreStatements(database, loaded) {
  const { input, artifact, byteSize } = loaded;
  const teamsJson = JSON.stringify(artifact.teams);
  const venuesJson = JSON.stringify(artifact.venues);
  const fixturesJson = JSON.stringify(artifact.fixtures);
  const teamIdsJson = JSON.stringify(artifact.teams.map(team => team.id));
  const fixtureIdsJson = JSON.stringify(artifact.fixtures.map(fixture => fixture.fixtureId));
  const statements = [
    statement(database, `
      INSERT INTO provider_sources(code, api_version) VALUES ('api-football', 'v3')
      ON CONFLICT(code) DO UPDATE SET api_version = excluded.api_version
    `),
    statement(database, `
      INSERT INTO product_seasons(canonical_id, label, starts_on, ends_on) VALUES (?, ?, ?, ?)
      ON CONFLICT(canonical_id) DO UPDATE SET label = excluded.label
    `, [artifact.productSeason.id, artifact.productSeason.label,
      artifact.productSeason.startsOn, artifact.productSeason.endsOn]),
    statement(database, `
      INSERT INTO competitions(
        canonical_id, source_id, provider_id, name, country_name, type, logo_url, flag_url
      ) VALUES (?, (SELECT id FROM provider_sources WHERE code = 'api-football'), ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_id) DO UPDATE SET name = excluded.name,
        country_name = excluded.country_name, type = excluded.type,
        logo_url = excluded.logo_url, flag_url = excluded.flag_url
    `, [artifact.competition.id, artifact.competition.providerId, artifact.competition.name,
      artifact.competition.country, artifact.competition.type, artifact.competition.logo,
      artifact.competition.flag]),
    statement(database, `
      INSERT INTO competition_seasons(
        canonical_id, competition_id, product_season_id, provider_season, label,
        starts_on, ends_on, status
      ) VALUES (
        ?, (SELECT id FROM competitions WHERE canonical_id = ?),
        (SELECT id FROM product_seasons WHERE canonical_id = ?), ?, ?, ?, ?, ?
      )
      ON CONFLICT(canonical_id) DO UPDATE SET product_season_id = excluded.product_season_id,
        label = excluded.label, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
        status = excluded.status
    `, [artifact.season.id, artifact.competition.id, artifact.productSeason.id,
      artifact.season.providerSeason, artifact.season.label, artifact.season.startsOn,
      artifact.season.endsOn, artifact.season.status]),
    statement(database, `
      INSERT INTO teams(canonical_id, source_id, provider_id, name, code, logo_url)
      SELECT json_extract(value, '$.id'),
        (SELECT id FROM provider_sources WHERE code = 'api-football'),
        json_extract(value, '$.providerId'), json_extract(value, '$.name'),
        json_extract(value, '$.code'), json_extract(value, '$.logo')
      FROM json_each(?) WHERE true
      ON CONFLICT(canonical_id) DO UPDATE SET name = excluded.name,
        code = excluded.code, logo_url = excluded.logo_url
    `, [teamsJson]),
    statement(database, `
      INSERT OR IGNORE INTO competition_season_teams(competition_season_id, team_id)
      SELECT (SELECT id FROM competition_seasons WHERE canonical_id = ?), team.id
      FROM json_each(?) expected JOIN teams team
        ON team.canonical_id = json_extract(expected.value, '$.id')
    `, [artifact.season.id, teamsJson]),
    statement(database, `
      INSERT INTO venues(canonical_id, source_id, provider_id, name, city)
      SELECT json_extract(value, '$.id'),
        (SELECT id FROM provider_sources WHERE code = 'api-football'),
        json_extract(value, '$.providerId'), json_extract(value, '$.name'),
        json_extract(value, '$.city')
      FROM json_each(?) WHERE true
      ON CONFLICT(canonical_id) DO UPDATE SET name = excluded.name, city = excluded.city
    `, [venuesJson]),
    statement(database, `
      INSERT INTO fixtures(
        canonical_id, source_id, provider_id, competition_season_id, venue_id,
        home_team_id, away_team_id, kickoff_utc, date_jst, round, referee,
        status_short, status_long, status_elapsed, home_goals, away_goals,
        home_winner, away_winner, ingestion_state
      )
      SELECT json_extract(value, '$.fixtureId'),
        (SELECT id FROM provider_sources WHERE code = 'api-football'),
        json_extract(value, '$.providerId'),
        (SELECT id FROM competition_seasons WHERE canonical_id = json_extract(value, '$.seasonId')),
        (SELECT id FROM venues WHERE canonical_id = json_extract(value, '$.venue.id')),
        (SELECT id FROM teams WHERE canonical_id = json_extract(value, '$.teams.home.id')),
        (SELECT id FROM teams WHERE canonical_id = json_extract(value, '$.teams.away.id')),
        json_extract(value, '$.kickoffUtc'), json_extract(value, '$.dateJst'),
        json_extract(value, '$.round'), json_extract(value, '$.referee'),
        json_extract(value, '$.status.short'), json_extract(value, '$.status.long'),
        json_extract(value, '$.status.elapsed'), json_extract(value, '$.score.goals.home'),
        json_extract(value, '$.score.goals.away'),
        CASE json_type(value, '$.teams.home.winner') WHEN 'true' THEN 1 WHEN 'false' THEN 0 ELSE NULL END,
        CASE json_type(value, '$.teams.away.winner') WHEN 'true' THEN 1 WHEN 'false' THEN 0 ELSE NULL END,
        json_extract(value, '$.ingestionState')
      FROM json_each(?) WHERE true
      ON CONFLICT(canonical_id) DO UPDATE SET
        competition_season_id = excluded.competition_season_id, venue_id = excluded.venue_id,
        home_team_id = excluded.home_team_id, away_team_id = excluded.away_team_id,
        kickoff_utc = excluded.kickoff_utc, date_jst = excluded.date_jst,
        round = excluded.round, referee = excluded.referee,
        status_short = excluded.status_short, status_long = excluded.status_long,
        status_elapsed = excluded.status_elapsed, home_goals = excluded.home_goals,
        away_goals = excluded.away_goals, home_winner = excluded.home_winner,
        away_winner = excluded.away_winner, ingestion_state = excluded.ingestion_state
    `, [fixturesJson]),
  ];
  for (const scoreKind of ['halftime', 'fulltime', 'extratime', 'penalty']) {
    statements.push(statement(database, `
      INSERT INTO fixture_score_parts(fixture_id, score_kind, home_value, away_value)
      SELECT fixture.id, ?, json_extract(item.value, '$.score.${scoreKind}.home'),
        json_extract(item.value, '$.score.${scoreKind}.away')
      FROM json_each(?) item JOIN fixtures fixture
        ON fixture.canonical_id = json_extract(item.value, '$.fixtureId')
      WHERE true
      ON CONFLICT(fixture_id, score_kind) DO UPDATE SET
        home_value = excluded.home_value, away_value = excluded.away_value
    `, [scoreKind, fixturesJson]));
  }
  statements.push(statement(database, `
    INSERT INTO raw_snapshots(
      source_id, r2_key, content_sha256, fetched_at, retention_class, byte_size
    ) VALUES (
      (SELECT id FROM provider_sources WHERE code = 'api-football'), ?, ?, ?,
      'migration-major-league-core', ?
    ) ON CONFLICT(r2_key) DO NOTHING
  `, [input.artifactKey, input.artifactSha256, artifact.source.observedAt, byteSize]));
  statements.push(statement(database, `
    INSERT INTO record_sources(
      raw_snapshot_id, fact_kind, fact_key, observed_at, verification, issue_flags_json
    ) VALUES (
      (SELECT id FROM raw_snapshots WHERE r2_key = ?),
      'major_league_core_snapshot', ?, ?, 'provider',
      CASE WHEN
        (SELECT COUNT(*) FROM raw_snapshots
          WHERE r2_key = ? AND content_sha256 = ? AND byte_size = ?) = 1
        AND (SELECT COUNT(*) FROM competition_season_teams membership
          JOIN competition_seasons season ON season.id = membership.competition_season_id
          WHERE season.canonical_id = ?) = ?
        AND NOT EXISTS (
          SELECT 1 FROM competition_season_teams membership
          JOIN competition_seasons season ON season.id = membership.competition_season_id
          JOIN teams team ON team.id = membership.team_id
          WHERE season.canonical_id = ?
            AND team.canonical_id NOT IN (SELECT value FROM json_each(?))
        )
        AND (SELECT COUNT(*) FROM fixtures fixture
          JOIN competition_seasons season ON season.id = fixture.competition_season_id
          WHERE season.canonical_id = ?) = ?
        AND NOT EXISTS (
          SELECT 1 FROM fixtures fixture
          JOIN competition_seasons season ON season.id = fixture.competition_season_id
          WHERE season.canonical_id = ?
            AND fixture.canonical_id NOT IN (SELECT value FROM json_each(?))
        )
      THEN '[]' ELSE 'major_league_core_integrity_failure' END
    )
    ON CONFLICT(fact_kind, fact_key, observed_at, raw_snapshot_id)
      DO UPDATE SET issue_flags_json = excluded.issue_flags_json
  `, [
    input.artifactKey, artifact.season.id, artifact.source.observedAt,
    input.artifactKey, input.artifactSha256, byteSize,
    artifact.season.id, artifact.teams.length,
    artifact.season.id, teamIdsJson,
    artifact.season.id, artifact.fixtures.length,
    artifact.season.id, fixtureIdsJson,
  ]));
  return statements;
}

export async function loadMajorLeagueCoreArtifact(env, request) {
  return readArtifact(env, request);
}

export async function publishMajorLeagueCoreFromR2(env, request) {
  const loaded = await readArtifact(env, request);
  await assertStoredIdentity(env.FOOTBALL_DB, loaded.artifact);
  await env.FOOTBALL_DB.batch(coreStatements(env.FOOTBALL_DB, loaded));
  return {
    schemaVersion: 'jfw-d1-admin-ingest-report/1',
    operation: MAJOR_LEAGUE_CORE_OPERATION,
    snapshotId: loaded.input.snapshotId,
    archiveSha256: loaded.input.archiveSha256,
    artifactKey: loaded.input.artifactKey,
    artifactSha256: loaded.input.artifactSha256,
    competitionId: loaded.input.competitionId,
    seasonId: loaded.input.seasonId,
    counts: {
      teams: loaded.artifact.teams.length,
      venues: loaded.artifact.venues.length,
      fixtures: loaded.artifact.fixtures.length,
    },
    imported: true,
    productionReady: false,
  };
}
