'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  fixtureIndexEntry,
  normalizeFixtureBundle,
  validateFixtureBundle,
} = require('../v2/fixture-contract');
const { normalizeStandings } = require('../v2/fetch-standings');

const SNAPSHOT_SCHEMA = 'jfw-api-football-major-leagues-snapshot/1';
const CORE_ARTIFACT_SCHEMA = 'jfw-d1-major-league-core-artifact/1';
const FIXTURE_ARTIFACT_SCHEMA = 'jfw-d1-fixture-migration-artifact/1';
const MIGRATION_MANIFEST_SCHEMA = 'jfw-d1-major-leagues-migration-manifest/1';
const FINAL_STATUSES = new Set(['FT', 'AET', 'PEN']);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[item.slice(2)] = true;
    else {
      result[item.slice(2)] = next;
      index += 1;
    }
  }
  return result;
}

function fail(message) {
  throw new Error(message);
}

function readJson(filePath, label = filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} is not readable JSON: ${error.message}`);
  }
  return parsed;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(filePath, bytes, 'utf8');
  return sha256(bytes);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileSha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function responseArray(payload, label) {
  if (!payload || !Array.isArray(payload.response)) fail(`${label}.response must be an array.`);
  return payload.response;
}

function canonicalInstant(value, label) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || new Date(value).toISOString() !== value) fail(`${label} must be a canonical UTC instant.`);
  return value;
}

function realDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} is not a real date.`);
  }
  return value;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function integer(value, label) {
  if (!Number.isSafeInteger(value)) fail(`${label} must be a safe integer.`);
  return value;
}

function unique(values, label) {
  const found = new Set();
  for (const value of values) {
    if (found.has(value)) fail(`${label} contains duplicate ${value}.`);
    found.add(value);
  }
  return found;
}

function parseTargets(config) {
  if (config?.schemaVersion !== 'jfw-d1-admin-ingest-plan/1'
    || !Array.isArray(config.standings) || config.standings.length === 0) {
    fail('Migration target config must declare a non-empty standings plan.');
  }
  const targets = config.standings.map((item, index) => {
    const competition = /^af:competition:(\d+)$/.exec(String(item?.competitionId || ''));
    const season = /^af:season:(\d+):(\d+)$/.exec(String(item?.seasonId || ''));
    if (!competition || !season || competition[1] !== season[1]) {
      fail(`Target ${index} has inconsistent competitionId and seasonId.`);
    }
    return {
      competitionId: item.competitionId,
      seasonId: item.seasonId,
      league: Number(competition[1]),
      season: Number(season[2]),
    };
  });
  unique(targets.map(item => item.league), 'Migration targets');
  return targets;
}

function exactNumericParameter(payload, key, expected, label) {
  if (String(payload?.parameters?.[key]) !== String(expected)) {
    fail(`${label}.parameters.${key} does not match ${expected}.`);
  }
}

function listNumericFiles(directory, expression, label) {
  const names = fs.readdirSync(directory).sort();
  return names.map(name => {
    const match = expression.exec(name);
    if (!match) fail(`${label} contains unexpected file ${name}.`);
    return { id: Number(match[1]), name, path: path.join(directory, name) };
  });
}

function validateLeagueSeason(leaguePayload, target) {
  exactNumericParameter(leaguePayload, 'id', target.league, `league-${target.league}/league.json`);
  exactNumericParameter(leaguePayload, 'season', target.season, `league-${target.league}/league.json`);
  const rows = responseArray(leaguePayload, `league-${target.league}/league.json`);
  if (rows.length !== 1) fail(`League ${target.league} metadata must contain exactly one league.`);
  const row = rows[0];
  if (Number(row?.league?.id) !== target.league) fail(`League ${target.league} metadata identity is wrong.`);
  const seasons = Array.isArray(row?.seasons) ? row.seasons : [];
  const matches = seasons.filter(item => Number(item?.year) === target.season);
  if (matches.length !== 1) fail(`League ${target.league} must contain exactly one season ${target.season}.`);
  const season = matches[0];
  const start = realDate(season.start, `League ${target.league} season.start`);
  const end = realDate(season.end, `League ${target.league} season.end`);
  if (!start.startsWith(`${target.season}-`)) {
    fail(`League ${target.league} season ${target.season} starts outside ${target.season}.`);
  }
  if (!end.startsWith(`${target.season + 1}-`)) {
    fail(`League ${target.league} season ${target.season} does not end in ${target.season + 1}.`);
  }
  if (start > end) fail(`League ${target.league} season dates are reversed.`);
  if (!row?.league?.name || !row?.country?.name) fail(`League ${target.league} metadata is incomplete.`);
  return { row, season, start, end };
}

function providerTeam(team, label) {
  const id = integer(Number(team?.id), `${label}.id`);
  if (!team?.name) fail(`${label}.name is required.`);
  return {
    id: `af:team:${id}`,
    providerId: id,
    name: String(team.name),
    code: team.code == null ? null : String(team.code),
    logo: team.logo == null ? null : String(team.logo),
  };
}

function providerVenue(venue, label) {
  if (venue?.id === null || venue?.id === undefined) return null;
  const id = integer(Number(venue.id), `${label}.id`);
  if (!venue.name) fail(`${label}.name is required when venue.id is present.`);
  return {
    id: `af:venue:${id}`,
    providerId: id,
    name: String(venue.name),
    city: venue.city == null ? null : String(venue.city),
  };
}

function snapshotFileSet(files) {
  return new Set(files.map(item => item.id));
}

function sameSet(actual, expected, label) {
  const missing = [...expected].filter(value => !actual.has(value));
  const extra = [...actual].filter(value => !expected.has(value));
  if (missing.length || extra.length) {
    fail(`${label} identity set mismatch (missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'}).`);
  }
}

function validateSupportingFiles(leagueDir, teamIds, manifestLeague) {
  const squads = listNumericFiles(path.join(leagueDir, 'squads'), /^(\d+)\.json$/, 'squads');
  const coaches = listNumericFiles(path.join(leagueDir, 'coaches'), /^(\d+)\.json$/, 'coaches');
  const statistics = listNumericFiles(path.join(leagueDir, 'team-statistics'), /^(\d+)\.json$/, 'team-statistics');
  for (const [files, label] of [[squads, 'squads'], [coaches, 'coaches'], [statistics, 'team-statistics']]) {
    sameSet(snapshotFileSet(files), teamIds, `League ${manifestLeague.league} ${label}`);
  }
  const squadPlayers = squads.reduce((sum, file) => sum + responseArray(readJson(file.path), file.path)
    .reduce((inner, row) => inner + (Array.isArray(row?.players) ? row.players.length : 0), 0), 0);
  const coachRows = coaches.reduce((sum, file) => sum + responseArray(readJson(file.path), file.path).length, 0);
  if (squadPlayers !== manifestLeague.squadPlayers) fail(`League ${manifestLeague.league} squad player total is inconsistent.`);
  if (coachRows !== manifestLeague.coaches) fail(`League ${manifestLeague.league} coach total is inconsistent.`);
  return { squadPlayers, coaches: coachRows };
}

function validatePlayers(leagueDir, target, manifestLeague) {
  const files = listNumericFiles(path.join(leagueDir, 'players'), /^page-(\d+)\.json$/, 'players');
  if (files.length !== manifestLeague.playerPages) fail(`League ${target.league} player page count is inconsistent.`);
  files.forEach((file, index) => {
    if (file.id !== index + 1) fail(`League ${target.league} player pages are not contiguous.`);
  });
  const ids = new Set();
  let rows = 0;
  for (const file of files) {
    const payload = readJson(file.path);
    exactNumericParameter(payload, 'league', target.league, file.path);
    exactNumericParameter(payload, 'season', target.season, file.path);
    for (const row of responseArray(payload, file.path)) {
      rows += 1;
      ids.add(integer(Number(row?.player?.id), `${file.path} player.id`));
    }
  }
  if (rows !== manifestLeague.playerRows || ids.size !== manifestLeague.uniquePlayers) {
    fail(`League ${target.league} player totals are inconsistent.`);
  }
  return { rows, uniquePlayers: ids.size };
}

function fixtureMigrationArtifact(bundle, source) {
  return {
    schemaVersion: FIXTURE_ARTIFACT_SCHEMA,
    source,
    bundle,
  };
}

function validateLeague(snapshotRoot, target, manifestLeague, context) {
  const leagueDir = path.join(snapshotRoot, `league-${target.league}`);
  if (!fs.statSync(leagueDir).isDirectory()) fail(`League directory is missing: ${leagueDir}`);
  const leaguePayload = readJson(path.join(leagueDir, 'league.json'));
  const metadata = validateLeagueSeason(leaguePayload, target);

  const teamsPayload = readJson(path.join(leagueDir, 'teams.json'));
  exactNumericParameter(teamsPayload, 'league', target.league, `League ${target.league} teams`);
  exactNumericParameter(teamsPayload, 'season', target.season, `League ${target.league} teams`);
  const rawTeams = responseArray(teamsPayload, `League ${target.league} teams`);
  const teams = rawTeams.map((item, index) => providerTeam(item?.team, `League ${target.league} teams[${index}]`));
  const teamProviderIds = unique(teams.map(item => item.providerId), `League ${target.league} teams`);
  if (teams.length !== manifestLeague.teams || teams.length === 0) fail(`League ${target.league} team count is inconsistent.`);
  const venues = rawTeams.map((item, index) => providerVenue(item?.venue, `League ${target.league} venues[${index}]`))
    .filter(Boolean);
  const venueById = new Map();
  for (const venue of venues) {
    const previous = venueById.get(venue.providerId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(venue)) {
      fail(`League ${target.league} venue ${venue.providerId} has conflicting metadata.`);
    }
    venueById.set(venue.providerId, venue);
  }

  const fixturesPayload = readJson(path.join(leagueDir, 'fixtures.json'));
  exactNumericParameter(fixturesPayload, 'league', target.league, `League ${target.league} fixtures`);
  exactNumericParameter(fixturesPayload, 'season', target.season, `League ${target.league} fixtures`);
  const rawFixtures = responseArray(fixturesPayload, `League ${target.league} fixtures`);
  const fixtureIds = unique(rawFixtures.map((fixture, index) => integer(
    Number(fixture?.fixture?.id), `League ${target.league} fixtures[${index}].id`,
  )), `League ${target.league} fixtures`);
  if (rawFixtures.length !== manifestLeague.fixtures || rawFixtures.length === 0) {
    fail(`League ${target.league} fixture count is inconsistent.`);
  }

  const fixtureBoundaryAdjustments = [];
  const coreFixtures = rawFixtures.map((fixture, index) => {
    if (Number(fixture?.league?.id) !== target.league || Number(fixture?.league?.season) !== target.season) {
      fail(`League ${target.league} fixture ${index} is outside the declared competition-season.`);
    }
    for (const side of ['home', 'away']) {
      const teamId = integer(Number(fixture?.teams?.[side]?.id), `Fixture ${fixture?.fixture?.id} ${side} team`);
      if (!teamProviderIds.has(teamId)) fail(`Fixture ${fixture?.fixture?.id} references team ${teamId} outside league ${target.league}.`);
    }
    const bundle = normalizeFixtureBundle(fixture, { fetchedAt: context.observedAt });
    bundle.detailAvailability = 'unavailable';
    const errors = validateFixtureBundle(bundle);
    if (errors.length) fail(`Fixture ${fixture?.fixture?.id} failed normalization: ${errors.join('; ')}`);
    if (bundle.fixture.dateJst < metadata.start || bundle.fixture.dateJst > metadata.end) {
      const earliestJst = shiftDate(metadata.start, -1);
      const latestJst = shiftDate(metadata.end, 1);
      if (bundle.fixture.dateJst < earliestJst || bundle.fixture.dateJst > latestJst) {
        fail(`Fixture ${bundle.fixture.id} date ${bundle.fixture.dateJst} is outside the one-day timezone boundary around ${metadata.start}..${metadata.end}.`);
      }
      fixtureBoundaryAdjustments.push({
        fixtureId: bundle.fixture.id,
        dateJst: bundle.fixture.dateJst,
        seasonStartsOn: metadata.start,
        seasonEndsOn: metadata.end,
        reason: 'provider-season-date-to-jst-boundary',
      });
    }
    if (bundle.fixture.venue.id && !venueById.has(bundle.fixture.venue.providerId)) {
      venueById.set(bundle.fixture.venue.providerId, {
        id: bundle.fixture.venue.id,
        providerId: bundle.fixture.venue.providerId,
        name: bundle.fixture.venue.name || 'Unknown venue',
        city: bundle.fixture.venue.city,
      });
    }
    return fixtureIndexEntry(bundle);
  });

  const finalIds = new Set(rawFixtures
    .filter(item => FINAL_STATUSES.has(String(item?.fixture?.status?.short || '').toUpperCase()))
    .map(item => Number(item.fixture.id)));
  const completedFiles = listNumericFiles(
    path.join(leagueDir, 'completed-fixtures'), /^(\d+)\.json$/, 'completed-fixtures',
  );
  sameSet(snapshotFileSet(completedFiles), finalIds, `League ${target.league} completed fixtures`);
  if (finalIds.size !== manifestLeague.completedFixtures
    || completedFiles.length !== manifestLeague.completedFixtureDetails) {
    fail(`League ${target.league} completed fixture totals are inconsistent.`);
  }

  const fixtureArtifacts = [];
  for (const file of completedFiles) {
    const raw = readJson(file.path);
    if (Number(raw?.fixture?.id) !== file.id || Number(raw?.league?.id) !== target.league
      || Number(raw?.league?.season) !== target.season) {
      fail(`Completed fixture ${file.id} has an inconsistent identity.`);
    }
    for (const section of ['events', 'lineups', 'players', 'statistics']) {
      if (!Array.isArray(raw?.[section])) fail(`Completed fixture ${file.id} is missing ${section}.`);
    }
    const bundle = normalizeFixtureBundle(raw, { fetchedAt: context.observedAt });
    const errors = validateFixtureBundle(bundle);
    if (errors.length) fail(`Completed fixture ${file.id} failed normalization: ${errors.join('; ')}`);
    const artifact = fixtureMigrationArtifact(bundle, context.source);
    const relativePath = path.join('fixtures', String(target.league), `${file.id}.json`);
    const outputPath = path.join(context.outputRoot, relativePath);
    const artifactSha256 = writeJson(outputPath, artifact);
    fixtureArtifacts.push({
      fixtureId: bundle.fixture.id,
      competitionId: target.competitionId,
      seasonId: target.seasonId,
      path: relativePath.replaceAll(path.sep, '/'),
      artifactSha256,
      r2Key: `${context.migrationPrefix}/fixtures/${file.id}-${artifactSha256}.json`,
    });
  }

  const standingsPayload = readJson(path.join(leagueDir, 'standings.json'));
  exactNumericParameter(standingsPayload, 'league', target.league, `League ${target.league} standings`);
  exactNumericParameter(standingsPayload, 'season', target.season, `League ${target.league} standings`);
  const standings = normalizeStandings(responseArray(standingsPayload, `League ${target.league} standings`), {
    league: target.league,
    season: target.season,
    fetchedAt: context.observedAt,
  });
  const standingRows = standings.groups.reduce((sum, group) => sum + group.table.length, 0);
  if (standingRows !== manifestLeague.standingsRows) fail(`League ${target.league} standings row count is inconsistent.`);
  for (const group of standings.groups) {
    for (const row of group.table) {
      if (!teamProviderIds.has(row.team.providerId)) {
        fail(`League ${target.league} standings references unknown team ${row.team.providerId}.`);
      }
    }
  }

  const players = validatePlayers(leagueDir, target, manifestLeague);
  const supporting = validateSupportingFiles(leagueDir, teamProviderIds, manifestLeague);
  const competition = {
    id: target.competitionId,
    providerId: target.league,
    name: String(metadata.row.league.name),
    country: String(metadata.row.country.name),
    logo: metadata.row.league.logo == null ? null : String(metadata.row.league.logo),
    flag: metadata.row.country.flag == null ? null : String(metadata.row.country.flag),
    type: String(metadata.row.league.type || 'League'),
  };
  const season = {
    id: target.seasonId,
    competitionId: target.competitionId,
    providerSeason: target.season,
    label: `${target.season}/${String(target.season + 1).slice(-2)}`,
    startsOn: metadata.start,
    endsOn: metadata.end,
    status: metadata.season.current === true ? 'current' : 'scheduled',
  };
  const coreArtifact = {
    schemaVersion: CORE_ARTIFACT_SCHEMA,
    source: context.source,
    productSeason: {
      id: `jfw:season:${target.season}-${String(target.season + 1).slice(-2)}`,
      label: `${target.season}/${String(target.season + 1).slice(-2)}`,
      startsOn: `${target.season}-07-01`,
      endsOn: `${target.season + 1}-06-30`,
    },
    competition,
    season,
    teams,
    venues: [...venueById.values()].sort((a, b) => a.providerId - b.providerId),
    fixtures: coreFixtures.sort((a, b) => a.fixtureId.localeCompare(b.fixtureId)),
    standings,
  };
  const coreRelativePath = path.join('core', `league-${target.league}.json`);
  const coreOutputPath = path.join(context.outputRoot, coreRelativePath);
  const coreSha256 = writeJson(coreOutputPath, coreArtifact);
  return {
    competitionId: target.competitionId,
    seasonId: target.seasonId,
    league: target.league,
    season: target.season,
    name: competition.name,
    country: competition.country,
    startsOn: season.startsOn,
    endsOn: season.endsOn,
    teamCount: teams.length,
    venueCount: coreArtifact.venues.length,
    fixtureCount: coreFixtures.length,
    completedFixtureCount: finalIds.size,
    fixtureBoundaryAdjustments,
    standingsRowCount: standingRows,
    playerRows: players.rows,
    uniquePlayers: players.uniquePlayers,
    squadPlayers: supporting.squadPlayers,
    coachRows: supporting.coaches,
    coreArtifact: {
      path: coreRelativePath.replaceAll(path.sep, '/'),
      artifactSha256: coreSha256,
      r2Key: `${context.migrationPrefix}/leagues/${target.league}/core-${coreSha256}.json`,
    },
    fixtureArtifacts,
  };
}

function validateManifest(snapshotRoot, latest, config, archiveFile, outputRoot) {
  const manifest = readJson(path.join(snapshotRoot, 'manifest.json'), 'snapshot manifest');
  if (manifest?.schemaVersion !== SNAPSHOT_SCHEMA || manifest.complete !== true) {
    fail('Snapshot manifest is not a complete supported snapshot.');
  }
  if (latest?.schemaVersion !== SNAPSHOT_SCHEMA || latest.complete !== true) {
    fail('R2 latest pointer is not a complete supported snapshot.');
  }
  const observedAt = canonicalInstant(manifest.completedAt, 'manifest.completedAt');
  if (JSON.stringify(manifest) !== JSON.stringify(Object.fromEntries(
    Object.entries(latest).filter(([key]) => !['archiveSha256', 'archiveKey'].includes(key)),
  ))) fail('R2 latest pointer does not embed the extracted snapshot manifest exactly.');
  if (!/^[0-9a-f]{64}$/.test(String(latest.archiveSha256 || ''))) fail('latest.archiveSha256 is invalid.');
  if (manifest?.r2?.archiveKey !== latest.archiveKey) fail('Latest pointer archive key does not match the manifest.');
  if (!/^audit\/api-football\/v3\/major-leagues\/2026\/snapshots\/[0-9TZ-]+\.tar\.gz$/.test(latest.archiveKey)) {
    fail('Latest pointer archive key is outside the reviewed audit prefix.');
  }
  if (archiveFile && fileSha256(archiveFile) !== latest.archiveSha256) fail('Downloaded R2 archive SHA-256 mismatch.');
  const targets = parseTargets(config);
  if (manifest.targetCount !== targets.length || !Array.isArray(manifest.leagues)
    || manifest.leagues.length !== targets.length) fail('Snapshot target count does not match reviewed config.');
  const manifestByLeague = new Map(manifest.leagues.map(item => [item.league, item]));
  unique(manifest.leagues.map(item => item.league), 'Snapshot manifest leagues');
  const actualDirectories = fs.readdirSync(snapshotRoot, { withFileTypes: true })
    .filter(item => item.isDirectory() && /^league-\d+$/.test(item.name))
    .map(item => Number(item.name.slice('league-'.length)));
  sameSet(new Set(actualDirectories), new Set(targets.map(item => item.league)), 'Snapshot league directories');
  const source = {
    provider: 'api-football',
    apiVersion: 'v3',
    snapshotId: manifest.snapshotId,
    archiveKey: latest.archiveKey,
    archiveSha256: latest.archiveSha256,
    observedAt,
  };
  const migrationPrefix = `migration/api-football/v3/major-leagues/2026/${latest.archiveSha256}`;
  const context = { outputRoot, observedAt, source, migrationPrefix };
  const leagues = targets.map(target => {
    const manifestLeague = manifestByLeague.get(target.league);
    if (!manifestLeague || manifestLeague.competitionId !== target.competitionId
      || manifestLeague.seasonId !== target.seasonId || manifestLeague.season !== target.season) {
      fail(`Snapshot manifest identity mismatch for league ${target.league}.`);
    }
    return validateLeague(snapshotRoot, target, manifestLeague, context);
  });
  unique(leagues.flatMap(item => item.fixtureArtifacts.map(fixture => fixture.fixtureId)), 'Completed fixture artifacts');
  const totals = {
    teams: leagues.reduce((sum, item) => sum + item.teamCount, 0),
    fixtures: leagues.reduce((sum, item) => sum + item.fixtureCount, 0),
    completedFixtures: leagues.reduce((sum, item) => sum + item.completedFixtureCount, 0),
    completedFixtureDetails: leagues.reduce((sum, item) => sum + item.fixtureArtifacts.length, 0),
    standingsRows: leagues.reduce((sum, item) => sum + item.standingsRowCount, 0),
    playerRows: leagues.reduce((sum, item) => sum + item.playerRows, 0),
    uniquePlayersByLeague: leagues.reduce((sum, item) => sum + item.uniquePlayers, 0),
    squadPlayers: leagues.reduce((sum, item) => sum + item.squadPlayers, 0),
    coaches: leagues.reduce((sum, item) => sum + item.coachRows, 0),
  };
  if (JSON.stringify(totals) !== JSON.stringify(manifest.totals)) fail('Recomputed snapshot totals do not match the manifest.');
  return { manifest, source, migrationPrefix, leagues, totals };
}

function prepare(options) {
  const snapshotRoot = path.resolve(options.snapshotRoot);
  const outputRoot = path.resolve(options.outputRoot);
  fs.mkdirSync(outputRoot, { recursive: true });
  const latest = readJson(path.resolve(options.latest), 'R2 latest pointer');
  const config = readJson(path.resolve(options.config), 'migration target config');
  const result = validateManifest(
    snapshotRoot, latest, config,
    options.archiveFile ? path.resolve(options.archiveFile) : null,
    outputRoot,
  );
  const validationReport = {
    schemaVersion: 'jfw-d1-major-leagues-validation-report/1',
    passed: true,
    source: result.source,
    seasonGate: result.leagues.map(item => ({
      league: item.league,
      competitionId: item.competitionId,
      seasonId: item.seasonId,
      providerSeason: item.season,
      startsOn: item.startsOn,
      endsOn: item.endsOn,
      fixtureBoundaryAdjustmentCount: item.fixtureBoundaryAdjustments.length,
      passed: item.startsOn.startsWith(`${item.season}-`)
        && item.endsOn.startsWith(`${item.season + 1}-`),
    })),
    totals: result.totals,
  };
  writeJson(path.join(outputRoot, 'validation-report.json'), validationReport);
  const migrationManifest = {
    schemaVersion: MIGRATION_MANIFEST_SCHEMA,
    source: result.source,
    migrationPrefix: result.migrationPrefix,
    publicR2ObjectsWritten: false,
    d1WritesPerformed: false,
    publicReadFlagsChanged: false,
    leagues: result.leagues,
    expectedTotals: {
      competitions: result.leagues.length,
      competitionSeasons: result.leagues.length,
      teams: result.totals.teams,
      fixtures: result.totals.fixtures,
      publishedFixtureDetails: result.totals.completedFixtureDetails,
      standingsPublications: result.leagues.length,
      standingsRows: result.totals.standingsRows,
    },
  };
  writeJson(path.join(outputRoot, 'migration-manifest.json'), migrationManifest);
  return { validationReport, migrationManifest };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['snapshot-root'] || !args.latest || !args.config || !args.out) {
    fail('Usage: prepare-major-league-d1-migration.js --snapshot-root DIR --latest FILE --config FILE --out DIR [--archive-file FILE]');
  }
  const result = prepare({
    snapshotRoot: args['snapshot-root'],
    latest: args.latest,
    config: args.config,
    outputRoot: args.out,
    archiveFile: args['archive-file'],
  });
  process.stdout.write(`${JSON.stringify({
    passed: result.validationReport.passed,
    source: result.validationReport.source,
    seasonGate: result.validationReport.seasonGate,
    totals: result.validationReport.totals,
    preparedCoreArtifacts: result.migrationManifest.leagues.length,
    preparedFixtureArtifacts: result.migrationManifest.leagues.reduce(
      (sum, item) => sum + item.fixtureArtifacts.length, 0,
    ),
  }, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

module.exports = {
  CORE_ARTIFACT_SCHEMA,
  FIXTURE_ARTIFACT_SCHEMA,
  MIGRATION_MANIFEST_SCHEMA,
  parseArgs,
  parseTargets,
  prepare,
  validateLeagueSeason,
  validateManifest,
};
