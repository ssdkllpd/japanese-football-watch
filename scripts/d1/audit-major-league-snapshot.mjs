#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import localD1Module from './local-d1.js';
import fixtureImporterModule from './fixture-bundle-importer.js';
import { validatePrepared } from './migrate-major-league-snapshot.mjs';
import { handleAdminIngest } from '../../admin-worker/index.mjs';

const { createLocalD1 } = localD1Module;
const { PLAYER_STAT_COLUMNS: PLAYER_COLUMNS, TEAM_STAT_COLUMNS: TEAM_COLUMNS } = fixtureImporterModule;

const PLAYER_FIELDS = {
  minutes: ['games', 'minutes'],
  rating: ['games', 'rating'],
  goals: ['goals', 'total'],
  assists: ['goals', 'assists'],
  goalsConceded: ['goals', 'conceded'],
  saves: ['goals', 'saves'],
  shots: ['shots', 'total'],
  shotsOnTarget: ['shots', 'on'],
  passes: ['passes', 'total'],
  keyPasses: ['passes', 'key'],
  passesAccurate: ['passes', 'accuracy'],
  tackles: ['tackles', 'total'],
  blocks: ['tackles', 'blocks'],
  interceptions: ['tackles', 'interceptions'],
  duels: ['duels', 'total'],
  duelsWon: ['duels', 'won'],
  dribbleAttempts: ['dribbles', 'attempts'],
  dribbles: ['dribbles', 'success'],
  dribbledPast: ['dribbles', 'past'],
  foulsDrawn: ['fouls', 'drawn'],
  foulsCommitted: ['fouls', 'committed'],
  yellowCards: ['cards', 'yellow'],
  redCards: ['cards', 'red'],
  penaltiesWon: ['penalty', 'won'],
  penaltiesConceded: ['penalty', 'commited'],
  penaltiesScored: ['penalty', 'scored'],
  penaltiesMissed: ['penalty', 'missed'],
  penaltiesSaved: ['penalty', 'saved'],
};

const DOMAIN_RULES = [
  ['shotsOnTarget', 'shots', 'shots_on_target_must_not_exceed_shots'],
  ['duelsWon', 'duels', 'duels_won_must_not_exceed_duels'],
  ['dribbles', 'dribbleAttempts', 'successful_dribbles_must_not_exceed_attempts'],
  ['goals', 'shots', 'goals_must_not_exceed_shots'],
];

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) result[key.slice(2)] = true;
    else {
      result[key.slice(2)] = value;
      index += 1;
    }
  }
  return result;
}

function readJson(filePath, label = filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function migrations(root) {
  return fs.readdirSync(root)
    .filter(file => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map(file => ({ file, sql: fs.readFileSync(path.join(root, file), 'utf8') }));
}

function openCurrentSchema(migrationsRoot) {
  const database = new DatabaseSync(':memory:');
  for (const migration of migrations(migrationsRoot)) database.exec(migration.sql);
  return database;
}

function fakeR2(uploadObjects) {
  const objects = new Map(uploadObjects.map(item => [item.r2Key, item.localPath]));
  return {
    async get(key) {
      const filePath = objects.get(key);
      if (!filePath) return null;
      return { async text() { return fs.readFileSync(filePath, 'utf8'); } };
    },
  };
}

function requestLocation(request, index) {
  const league = /^af:competition:(\d+)$/.exec(String(request.competitionId || ''));
  return {
    globalRequestIndex: index + 1,
    operation: request.operation,
    leagueId: league ? Number(league[1]) : null,
    fixtureId: request.fixtureId || null,
    date: request.date || null,
  };
}

async function executeLocalRequests(prepared, database) {
  const environment = {
    ADMIN_INGEST_TOKEN: 'local-snapshot-audit-token',
    FOOTBALL_DB: createLocalD1(database),
    FOOTBALL_DATA: fakeR2(prepared.uploadObjects),
  };
  const results = [];
  for (const [index, input] of prepared.requests.entries()) {
    const location = requestLocation(input, index);
    try {
      const request = new Request('https://local.invalid/admin/v1/ingest', {
        method: 'POST',
        headers: {
          authorization: 'Bearer local-snapshot-audit-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      });
      const response = await handleAdminIngest(request, environment);
      const body = await response.json();
      results.push({
        ...location,
        passed: response.ok && body?.ok === true,
        status: response.status,
        ...(body?.report ? { report: body.report } : {}),
        ...(body?.detail ? { detail: body.detail } : {}),
        ...(body?.error ? { error: body.error } : {}),
      });
    } catch (error) {
      results.push({ ...location, passed: false, status: null, error: error?.name || 'Error', detail: String(error?.message || error) });
    }
  }
  return results;
}

function valueAt(object, segments) {
  let current = object;
  for (const segment of segments) current = current?.[segment];
  return current;
}

function rawPlayerRows(raw) {
  const rows = new Map();
  for (const teamBlock of raw?.players || []) {
    const teamId = Number(teamBlock?.team?.id);
    for (const item of teamBlock?.players || []) {
      const playerId = Number(item?.player?.id);
      if (!Number.isSafeInteger(playerId) || playerId <= 0) continue;
      rows.set(`${teamId}:${playerId}`, {
        teamId,
        playerId,
        stats: Array.isArray(item.statistics) ? (item.statistics[0] || {}) : {},
      });
    }
  }
  return rows;
}

function teamStatKey(type) {
  return String(type || '').trim().toLowerCase().replace(/%/g, ' percent ')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function rawTeamRows(raw) {
  return new Map((raw?.statistics || []).map(block => [Number(block?.team?.id),
    new Map((block?.statistics || []).map(row => [teamStatKey(row?.type), row?.value]))]));
}

function tableTypes(database, table) {
  return new Map(database.prepare(`PRAGMA table_info(${table})`).all()
    .map(column => [column.name, String(column.type || '').toUpperCase()]));
}

function traceBase({ requestIndex, requestPassed, leagueId, fixtureId, stat, artifact,
  rawValue, normalizedValue, d1Value, key, column, factKind = 'player_stat' }) {
  return {
    globalRequestIndex: requestIndex,
    operation: 'fixture_migration_publish',
    leagueId,
    fixtureId,
    factKind,
    playerId: stat.playerId || null,
    teamId: stat.teamId,
    d1Column: column,
    normalizedBundleKey: `${factKind === 'player_stat' ? 'playerStats' : 'teamStats'}.values.${key}`,
    rawProviderValue: rawValue === undefined ? null : rawValue,
    normalizedValue: normalizedValue ?? stat.values[key],
    d1Value,
    d1WriteOutcome: requestPassed ? 'persisted' : 'request_rolled_back_or_failed',
    artifactPath: artifact.path,
    r2Key: artifact.r2Key,
  };
}

function fixtureTraceBase({ requestIndex, requestPassed, leagueId, fixtureId, artifact,
  factKind, d1Column, normalizedBundleKey, rawProviderValue, normalizedValue }) {
  return {
    globalRequestIndex: requestIndex,
    operation: 'fixture_migration_publish',
    leagueId,
    fixtureId,
    factKind,
    playerId: null,
    teamId: null,
    d1Column,
    normalizedBundleKey,
    rawProviderValue: rawProviderValue === undefined ? null : rawProviderValue,
    normalizedValue,
    d1Value: null,
    d1WriteOutcome: requestPassed ? 'persisted' : 'request_rolled_back_or_failed',
    artifactPath: artifact.path,
    r2Key: artifact.r2Key,
  };
}

function storedStatRows(database) {
  const playerColumns = Object.values(PLAYER_COLUMNS).map(column => `stats.${column}`).join(', ');
  const teamColumns = Object.values(TEAM_COLUMNS).map(column => `stats.${column}`).join(', ');
  const players = database.prepare(`
    SELECT fixture.canonical_id AS fixture_id, player.canonical_id AS player_id,
      team.canonical_id AS team_id, ${playerColumns}
    FROM fixture_player_stats stats
    JOIN fixture_player_appearances appearance ON appearance.id = stats.player_appearance_id
    JOIN fixture_player_records record ON record.id = appearance.player_record_id
    JOIN fixtures fixture ON fixture.id = record.fixture_id
    JOIN players player ON player.id = record.player_id
    JOIN teams team ON team.id = record.team_id
    WHERE fixture.published_revision = appearance.fixture_revision_id
  `).all();
  const teams = database.prepare(`
    SELECT fixture.canonical_id AS fixture_id, team.canonical_id AS team_id, ${teamColumns}
    FROM fixture_team_stats stats
    JOIN fixture_revisions revision ON revision.id = stats.fixture_revision_id
    JOIN fixtures fixture ON fixture.id = revision.fixture_id
    JOIN teams team ON team.id = stats.team_id
    WHERE fixture.published_revision = revision.id
  `).all();
  return {
    players: new Map(players.map(row => [`${row.fixture_id}:${row.team_id}:${row.player_id}`, row])),
    teams: new Map(teams.map(row => [`${row.fixture_id}:${row.team_id}`, row])),
  };
}

function venuePersistenceIssue(database, fixtureId, venue) {
  if (!venue?.id || venue.name) return null;
  const fixture = database.prepare('SELECT venue_id FROM fixtures WHERE canonical_id = ?').get(fixtureId);
  const master = database.prepare('SELECT id, name FROM venues WHERE canonical_id = ?').get(venue.id);
  if (master && fixture?.venue_id === master.id && String(master.name || '').trim()) return null;
  if (!master && fixture?.venue_id === null) return null;
  return master
    ? {
      expectedConstraint: 'a nameless identified venue reuses the existing named venue master',
      reason: 'existing_nameless_venue_not_reused',
    }
    : {
      expectedConstraint: 'a nameless identified venue without a master is persisted as fixture.venue_id NULL',
      reason: 'unresolved_nameless_venue_was_linked',
    };
}

function scanFixtureSemantics(prepared, snapshotRoot, database, results = []) {
  const manifest = readJson(prepared.manifestPath, 'prepared migration manifest');
  const requestIndexes = new Map(prepared.requests.map((request, index) => [request.fixtureId, index + 1]));
  const types = tableTypes(database, 'fixture_player_stats');
  const teamTypes = tableTypes(database, 'fixture_team_stats');
  const stored = storedStatRows(database);
  const requestOutcomes = new Map(results.filter(item => item.fixtureId)
    .map(item => [item.fixtureId, item.passed]));
  const issues = [];
  const passSamples = [];
  const ratings = [];
  let normalizedPlayerStatRows = 0;
  let normalizedTeamStatRows = 0;
  for (const league of manifest.leagues) {
    for (const artifact of league.fixtureArtifacts) {
      const wrapper = readJson(path.resolve(path.dirname(prepared.manifestPath), artifact.path), artifact.path);
      const fixtureId = wrapper.bundle.fixture.id;
      const providerFixtureId = wrapper.bundle.fixture.providerId;
      const rawPath = path.join(snapshotRoot, `league-${league.league}`, 'completed-fixtures', `${providerFixtureId}.json`);
      const raw = readJson(rawPath, `raw fixture ${providerFixtureId}`);
      const rawRows = rawPlayerRows(raw);
      const rawTeams = rawTeamRows(raw);
      const requestPassed = requestOutcomes.get(fixtureId) === true;
      const venueIssue = venuePersistenceIssue(database, fixtureId, wrapper.bundle.fixture?.venue);
      if (venueIssue) {
        issues.push({
          ...fixtureTraceBase({
            requestIndex: requestIndexes.get(fixtureId), requestPassed, leagueId: league.league,
            fixtureId, artifact, factKind: 'venue', d1Column: 'venues.name',
            normalizedBundleKey: 'fixture.venue.name',
            rawProviderValue: raw?.fixture?.venue?.name,
            normalizedValue: wrapper.bundle.fixture.venue.name,
          }),
          expectedConstraint: venueIssue.expectedConstraint,
          severity: 'error',
          reason: venueIssue.reason,
        });
      }
      for (const [eventIndex, event] of (wrapper.bundle.events || []).entries()) {
        if (typeof event.elapsed === 'number' && event.elapsed < 0) {
          issues.push({
            ...fixtureTraceBase({
              requestIndex: requestIndexes.get(fixtureId), requestPassed, leagueId: league.league,
              fixtureId, artifact, factKind: 'event', d1Column: 'fixture_events.elapsed',
              normalizedBundleKey: `events[${eventIndex}].elapsed`,
              rawProviderValue: raw?.events?.[eventIndex]?.time?.elapsed,
              normalizedValue: event.elapsed,
            }),
            expectedConstraint: 'fixture_events.elapsed IS NULL OR elapsed >= 0',
            severity: 'error',
            reason: 'negative_event_elapsed',
          });
        }
      }
      for (const stat of wrapper.bundle.playerStats || []) {
        normalizedPlayerStatRows += 1;
        const playerProviderId = Number(stat.playerProviderId);
        const teamProviderId = Number(String(stat.teamId || '').split(':').at(-1));
        const rawRow = rawRows.get(`${teamProviderId}:${playerProviderId}`);
        for (const [key, normalizedValue] of Object.entries(stat.values || {})) {
          const column = PLAYER_COLUMNS[key];
          if (!column) continue;
          const rawValue = valueAt(rawRow?.stats, PLAYER_FIELDS[key] || []);
          const base = traceBase({
            requestIndex: requestIndexes.get(fixtureId), requestPassed, leagueId: league.league,
            fixtureId, stat, artifact, rawValue, normalizedValue,
            d1Value: stored.players.get(`${fixtureId}:${stat.teamId}:${stat.playerId}`)?.[column] ?? null,
            key, column,
          });
          const type = types.get(column);
          if (typeof normalizedValue !== 'number' || !Number.isFinite(normalizedValue)) {
            issues.push({ ...base, expectedConstraint: `${type || 'NUMERIC'} finite number`, severity: 'error', reason: 'non_finite_or_non_numeric_normalized_value' });
          } else if (type === 'INTEGER' && !Number.isInteger(normalizedValue)) {
            issues.push({ ...base, expectedConstraint: 'SQLite INTEGER without implicit coercion', severity: 'error', reason: 'non_integer_normalized_value' });
          }
        }

        if (Object.hasOwn(stat.values || {}, 'passesAccurate')) {
          const rawAccuracy = valueAt(rawRow?.stats, PLAYER_FIELDS.passesAccurate);
          const rawPasses = valueAt(rawRow?.stats, PLAYER_FIELDS.passes);
          passSamples.push({ rawAccuracy, rawPasses, normalizedValue: stat.values.passesAccurate });
        }
        if (Object.hasOwn(stat.values || {}, 'rating')) ratings.push(stat.values.rating);
        for (const [left, right, reason] of DOMAIN_RULES) {
          if (typeof stat.values?.[left] === 'number' && typeof stat.values?.[right] === 'number'
            && stat.values[left] > stat.values[right]) {
            const rawValue = valueAt(rawRow?.stats, PLAYER_FIELDS[left]);
            issues.push({
              ...traceBase({
                requestIndex: requestIndexes.get(fixtureId), leagueId: league.league,
                requestPassed, fixtureId, stat, artifact, rawValue,
                d1Value: stored.players.get(`${fixtureId}:${stat.teamId}:${stat.playerId}`)?.[PLAYER_COLUMNS[left]] ?? null,
                key: left, column: PLAYER_COLUMNS[left],
              }),
              expectedConstraint: `${left} <= ${right}`,
              severity: 'warning',
              reason,
            });
          }
        }
      }
      for (const stat of wrapper.bundle.teamStats || []) {
        normalizedTeamStatRows += 1;
        const teamProviderId = Number(String(stat.teamId || '').split(':').at(-1));
        for (const [key, normalizedValue] of Object.entries(stat.values || {})) {
          const column = TEAM_COLUMNS[key];
          if (!column) continue;
          const type = teamTypes.get(column);
          if ((typeof normalizedValue !== 'number' || !Number.isFinite(normalizedValue))
            || (type === 'INTEGER' && !Number.isInteger(normalizedValue))) {
            issues.push({
              ...traceBase({
                requestIndex: requestIndexes.get(fixtureId), requestPassed, leagueId: league.league,
                fixtureId, stat, artifact, rawValue: rawTeams.get(teamProviderId)?.get(key),
                normalizedValue,
                d1Value: stored.teams.get(`${fixtureId}:${stat.teamId}`)?.[column] ?? null,
                key, column, factKind: 'team_stat',
              }),
              expectedConstraint: type === 'INTEGER'
                ? 'SQLite INTEGER without implicit coercion' : `${type || 'NUMERIC'} finite number`,
              severity: 'error',
              reason: type === 'INTEGER' ? 'non_integer_normalized_value' : 'non_finite_or_non_numeric_normalized_value',
            });
          }
        }
      }
    }
  }
  const comparablePasses = passSamples.filter(item => Number.isFinite(Number(item.rawAccuracy)) && Number.isFinite(Number(item.rawPasses)));
  const ratingNumbers = ratings.filter(value => typeof value === 'number' && Number.isFinite(value));
  return {
    normalizedPlayerStatRows,
    normalizedTeamStatRows,
    issues,
    passSemantics: {
      observed: passSamples.length,
      rawEqualsNormalized: passSamples.filter(item => Number(item.rawAccuracy) === item.normalizedValue).length,
      comparableWithPassTotal: comparablePasses.length,
      rawAccuracyAtMostPassTotal: comparablePasses.filter(item => Number(item.rawAccuracy) <= Number(item.rawPasses)).length,
      rawAccuracyAbove100: comparablePasses.filter(item => Number(item.rawAccuracy) > 100).length,
      conclusion: 'API-Football passes.accuracy is persisted as successful-pass count passesAccurate, never as a percentage.',
    },
    providerRating: {
      observed: ratings.length,
      finiteNumbers: ratingNumbers.length,
      minimum: ratingNumbers.length ? Math.min(...ratingNumbers) : null,
      maximum: ratingNumbers.length ? Math.max(...ratingNumbers) : null,
      outsideZeroToTen: ratingNumbers.filter(value => value < 0 || value > 10).length,
      nonFiniteOrNonNumeric: ratings.length - ratingNumbers.length,
    },
  };
}

function operationSummary(results) {
  const summary = {};
  for (const result of results) {
    summary[result.operation] ||= { total: 0, passed: 0, failed: 0 };
    summary[result.operation].total += 1;
    summary[result.operation][result.passed ? 'passed' : 'failed'] += 1;
  }
  return summary;
}

function integrity(database) {
  return {
    foreignKeyViolations: database.prepare('PRAGMA foreign_key_check').all(),
    integrityCheck: database.prepare('PRAGMA integrity_check').all(),
  };
}

function issueSummary(issues) {
  const bySeverity = {};
  const byColumn = {};
  const byReason = {};
  const affectedFixtures = new Set();
  for (const issue of issues) {
    bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
    byColumn[issue.d1Column] = (byColumn[issue.d1Column] || 0) + 1;
    byReason[issue.reason] = (byReason[issue.reason] || 0) + 1;
    if (issue.fixtureId) affectedFixtures.add(issue.fixtureId);
  }
  return {
    total: issues.length, bySeverity, byColumn, byReason,
    affectedFixtures: [...affectedFixtures].sort(),
  };
}

async function audit(options) {
  const prepared = validatePrepared(path.resolve(options.prepared), path.resolve(options.evidence));
  const database = openCurrentSchema(path.resolve(options.migrations));
  const results = await executeLocalRequests(prepared, database);
  const semantic = scanFixtureSemantics(prepared, path.resolve(options.snapshotRoot), database, results);
  const databaseIntegrity = integrity(database);
  const authoritativePassed = results.length === prepared.requests.length
    && results.every(result => result.passed)
    && databaseIntegrity.foreignKeyViolations.length === 0
    && databaseIntegrity.integrityCheck.length === 1
    && databaseIntegrity.integrityCheck[0].integrity_check === 'ok';
  const diagnosticsPassed = semantic.issues.every(issue => issue.severity !== 'error');
  const report = {
    schemaVersion: 'jfw-d1-major-leagues-snapshot-audit/1',
    mode: 'local-authoritative-schema-audit',
    source: prepared.source,
    migrations: migrations(path.resolve(options.migrations)).map(item => ({ file: item.file, sha256: sha256(item.sql) })),
    validation: { summary: prepared.summary, requestCountMatches: prepared.requests.length === 564 },
    authoritative: {
      passed: authoritativePassed,
      attempted: results.length,
      operationSummary: operationSummary(results),
      failedRequests: results.filter(result => !result.passed),
      databaseIntegrity,
    },
    diagnostics: {
      passed: diagnosticsPassed,
      summary: issueSummary(semantic.issues),
      passSemantics: semantic.passSemantics,
      providerRating: semantic.providerRating,
      issues: semantic.issues,
    },
    passed: authoritativePassed && diagnosticsPassed,
    productionReady: false,
    remoteD1WritesPerformed: false,
    apiFootballRequestsPerformed: false,
    publicReadFlagsChanged: false,
  };
  database.close();
  return report;
}

export { audit, executeLocalRequests, requestLocation, scanFixtureSemantics, venuePersistenceIssue };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const key of ['prepared', 'snapshot-root', 'evidence', 'report']) {
    if (!args[key]) throw new Error(`--${key} is required.`);
  }
  const report = await audit({
    prepared: args.prepared,
    snapshotRoot: args['snapshot-root'],
    evidence: args.evidence,
    report: args.report,
    migrations: args.migrations || path.resolve('migrations'),
  });
  const output = path.resolve(args.report);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    requests: report.authoritative.attempted,
    operationSummary: report.authoritative.operationSummary,
    diagnostics: report.diagnostics.summary,
    passSemantics: report.diagnostics.passSemantics,
    providerRating: report.diagnostics.providerRating,
    passed: report.passed,
  })}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
