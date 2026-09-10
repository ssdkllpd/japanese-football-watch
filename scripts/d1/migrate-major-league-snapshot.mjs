#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fixtureImporterModule from './fixture-bundle-importer.js';

const { correctionDefinitions } = fixtureImporterModule;
const MANIFEST_SCHEMA = 'jfw-d1-major-leagues-migration-manifest/1';
const EVIDENCE_SCHEMA = 'jfw-d1-major-leagues-reviewed-evidence/1';
const REQUEST_SCHEMA = 'jfw-d1-admin-ingest/1';

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

function fail(message) {
  throw new Error(message);
}

function readJson(filePath, label = filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) {
    fail(`${label} is not readable JSON: ${error.message}`);
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveArtifact(root, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    fail(`${label} must be a relative path.`);
  }
  const base = fs.realpathSync(root);
  const resolved = path.resolve(base, relativePath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail(`${label} escapes the prepared directory.`);
  const real = fs.realpathSync(resolved);
  const realRelative = path.relative(base, real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    fail(`${label} escapes the prepared directory through a link.`);
  }
  return real;
}

function sameJson(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} differs from reviewed evidence.`);
}

function sourceMatches(value, source) {
  return value?.provider === source.provider && value?.apiVersion === source.apiVersion
    && value?.snapshotId === source.snapshotId && value?.archiveKey === source.archiveKey
    && value?.archiveSha256 === source.archiveSha256
    && value?.archiveByteSize === source.archiveByteSize && value?.observedAt === source.observedAt;
}

function checkedArtifact(root, declaration, label) {
  const filePath = resolveArtifact(root, declaration.path, `${label}.path`);
  if (!/^[0-9a-f]{64}$/.test(String(declaration.artifactSha256 || ''))
    || sha256File(filePath) !== declaration.artifactSha256) {
    fail(`${label} SHA-256 mismatch.`);
  }
  return { filePath, value: readJson(filePath, label) };
}

function validatePrepared(preparedRoot, evidencePath) {
  const root = fs.realpathSync(preparedRoot);
  const manifestPath = resolveArtifact(root, 'migration-manifest.json', 'migration manifest');
  const manifest = readJson(manifestPath, 'migration manifest');
  const evidence = readJson(path.resolve(evidencePath), 'reviewed evidence');
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA || evidence?.schemaVersion !== EVIDENCE_SCHEMA) {
    fail('Prepared migration manifest or reviewed evidence schema is unsupported.');
  }
  if (manifest.publicR2ObjectsWritten !== false || manifest.d1WritesPerformed !== false
    || manifest.publicReadFlagsChanged !== false) {
    fail('Prepared migration manifest contains an unsafe prior action marker.');
  }
  const source = manifest.source;
  if (source.provider !== 'api-football' || source.apiVersion !== 'v3'
    || source.snapshotId !== evidence.snapshotId || source.archiveKey !== evidence.archiveKey
    || source.archiveSha256 !== evidence.archiveSha256
    || !Number.isSafeInteger(source.archiveByteSize) || source.archiveByteSize <= 0) {
    fail('Prepared migration source differs from reviewed evidence.');
  }
  sameJson(manifest.expectedTotals, {
    competitions: evidence.leagues.length,
    competitionSeasons: evidence.leagues.length,
    teams: evidence.totals.teams,
    fixtures: evidence.totals.fixtures,
    publishedFixtureDetails: evidence.totals.completedFixtureDetails,
    standingsPublications: evidence.leagues.length,
    standingsRows: evidence.totals.standingsRows,
    dateIndexCoverages: manifest.dateCoverageArtifact.dateCount,
    competitionDateIndexCoverages: manifest.dateCoverageArtifact.competitionDateCount,
  }, 'Prepared expected totals');
  if (!Array.isArray(manifest.leagues) || manifest.leagues.length !== evidence.leagues.length) {
    fail('Prepared league count differs from reviewed evidence.');
  }
  const evidenceByLeague = new Map(evidence.leagues.map(item => [item.league, item]));
  const requests = [];
  const uploadObjects = [];
  const completedFixtureIds = [];
  const standings = [];
  const majorLeagueSeasons = [];
  for (const league of manifest.leagues) {
    const expected = evidenceByLeague.get(league.league);
    sameJson({
      league: league.league,
      competitionId: league.competitionId,
      seasonId: league.seasonId,
      providerSeason: league.season,
      startsOn: league.startsOn,
      endsOn: league.endsOn,
      teamCount: league.teamCount,
      fixtureCount: league.fixtureCount,
      completedFixtureDetailCount: league.fixtureArtifacts.length,
      standingsRowCount: league.standingsRowCount,
    }, expected, `League ${league.league}`);
    const core = checkedArtifact(root, league.coreArtifact, `League ${league.league} core artifact`);
    if (core.value?.schemaVersion !== 'jfw-d1-major-league-core-artifact/1'
      || !sourceMatches(core.value.source, source)
      || core.value.competition?.id !== league.competitionId
      || core.value.season?.id !== league.seasonId
      || core.value.teams?.length !== league.teamCount
      || core.value.fixtures?.length !== league.fixtureCount) {
      fail(`League ${league.league} core artifact does not match its declaration.`);
    }
    uploadObjects.push({
      path: league.coreArtifact.path,
      localPath: core.filePath,
      r2Key: league.coreArtifact.r2Key,
      sha256: league.coreArtifact.artifactSha256,
    });
    const common = {
      schemaVersion: REQUEST_SCHEMA,
      snapshotId: source.snapshotId,
      archiveSha256: source.archiveSha256,
      artifactKey: league.coreArtifact.r2Key,
      artifactSha256: league.coreArtifact.artifactSha256,
      competitionId: league.competitionId,
      seasonId: league.seasonId,
    };
    requests.push({ ...common, operation: 'major_league_core_publish' });
    standings.push({ competitionId: league.competitionId, seasonId: league.seasonId });
    majorLeagueSeasons.push({
      competitionId: league.competitionId,
      seasonId: league.seasonId,
      startsOn: league.startsOn,
      endsOn: league.endsOn,
      teamCount: league.teamCount,
      fixtureCount: league.fixtureCount,
      publishedFixtureDetailCount: league.fixtureArtifacts.length,
      standingsRowCount: league.standingsRowCount,
      coreArtifactKey: league.coreArtifact.r2Key,
      coreArtifactSha256: league.coreArtifact.artifactSha256,
    });
    for (const fixture of league.fixtureArtifacts) {
      const loaded = checkedArtifact(root, fixture, `Fixture ${fixture.fixtureId} artifact`);
      if (loaded.value?.schemaVersion !== 'jfw-d1-fixture-migration-artifact/1'
        || !sourceMatches(loaded.value.source, source)
        || loaded.value.bundle?.fixture?.id !== fixture.fixtureId
        || loaded.value.bundle?.fixture?.competitionId !== fixture.competitionId
        || loaded.value.bundle?.fixture?.seasonId !== fixture.seasonId) {
        fail(`Fixture ${fixture.fixtureId} artifact does not match its declaration.`);
      }
      uploadObjects.push({
        path: fixture.path, localPath: loaded.filePath, r2Key: fixture.r2Key,
        sha256: fixture.artifactSha256,
      });
      completedFixtureIds.push(fixture.fixtureId);
      fixture.request = {
        schemaVersion: REQUEST_SCHEMA,
        operation: 'fixture_migration_publish',
        snapshotId: source.snapshotId,
        archiveSha256: source.archiveSha256,
        fixtureId: fixture.fixtureId,
        competitionId: fixture.competitionId,
        seasonId: fixture.seasonId,
        artifactKey: fixture.r2Key,
        artifactSha256: fixture.artifactSha256,
        reuseStoredCatalog: true,
        correctionDefinitions: {
          schemaVersion: 'd1-fixture-correction-definitions/1',
          fixtureId: fixture.fixtureId,
          definitions: correctionDefinitions(loaded.value.bundle),
        },
      };
    }
  }
  for (const league of manifest.leagues) {
    requests.push({
      schemaVersion: REQUEST_SCHEMA,
      operation: 'major_league_standings_publish',
      snapshotId: source.snapshotId,
      archiveSha256: source.archiveSha256,
      artifactKey: league.coreArtifact.r2Key,
      artifactSha256: league.coreArtifact.artifactSha256,
      competitionId: league.competitionId,
      seasonId: league.seasonId,
    });
  }
  for (const league of manifest.leagues) {
    requests.push(...league.fixtureArtifacts.map(item => item.request));
    league.fixtureArtifacts.forEach(item => { delete item.request; });
  }
  const coverage = checkedArtifact(root, manifest.dateCoverageArtifact, 'Date coverage artifact');
  if (coverage.value?.schemaVersion !== 'jfw-d1-major-league-date-coverage-artifact/1'
    || !sourceMatches(coverage.value.source, source)
    || !Array.isArray(coverage.value.dates)
    || coverage.value.dates.length !== manifest.dateCoverageArtifact.dateCount) {
    fail('Date coverage artifact does not match its declaration.');
  }
  uploadObjects.push({
    path: manifest.dateCoverageArtifact.path,
    localPath: coverage.filePath,
    r2Key: manifest.dateCoverageArtifact.r2Key,
    sha256: manifest.dateCoverageArtifact.artifactSha256,
  });
  const dateIndexCoverages = coverage.value.dates.map(item => ({
    date: item.date,
    competitionIds: item.competitions.map(scope => scope.competitionId),
  }));
  const competitionDateCount = dateIndexCoverages.reduce(
    (sum, item) => sum + item.competitionIds.length, 0,
  );
  if (competitionDateCount !== manifest.dateCoverageArtifact.competitionDateCount) {
    fail('Date coverage competition count differs from its declaration.');
  }
  requests.push(...dateIndexCoverages.map(item => ({
    schemaVersion: REQUEST_SCHEMA,
    operation: 'major_league_date_coverage_publish',
    snapshotId: source.snapshotId,
    archiveSha256: source.archiveSha256,
    artifactKey: manifest.dateCoverageArtifact.r2Key,
    artifactSha256: manifest.dateCoverageArtifact.artifactSha256,
    date: item.date,
    competitionIds: item.competitionIds,
  })));
  requests.push({
    schemaVersion: REQUEST_SCHEMA,
    operation: 'migration_verify',
    snapshotId: source.snapshotId,
    archiveSha256: source.archiveSha256,
    fixedSnapshot: null,
    fixtureIds: completedFixtureIds,
    standings,
    dateIndexCoverages,
    majorLeagueSeasons,
    expectedTotals: null,
  });
  const identities = uploadObjects.map(item => item.r2Key);
  if (new Set(identities).size !== identities.length) fail('Prepared upload objects contain duplicate R2 keys.');
  return {
    manifestPath,
    source,
    requests,
    uploadObjects,
    summary: {
      competitions: manifest.leagues.length,
      coreFixtures: manifest.leagues.reduce((sum, item) => sum + item.fixtureCount, 0),
      fixtureDetails: completedFixtureIds.length,
      standings: standings.length,
      dateCoverages: dateIndexCoverages.length,
      competitionDateCoverages: competitionDateCount,
      uploadObjects: uploadObjects.length,
      adminRequests: requests.length,
    },
  };
}

function endpoint(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    fail('Admin ingest URL must be a credential-free HTTPS URL.');
  }
  parsed.pathname = '/admin/v1/ingest';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function requestIdentity(request) {
  if (request.fixtureId) return request.fixtureId;
  if (request.date) return request.date;
  if (request.competitionId) return `${request.competitionId}/${request.seasonId}`;
  return 'complete-major-league-migration';
}

async function executeRequests(prepared, options) {
  if (!options.token) fail('ADMIN_INGEST_TOKEN is required for execution.');
  const url = endpoint(options.url);
  const results = [];
  for (const [index, request] of prepared.requests.entries()) {
    const identity = requestIdentity(request);
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) {
        results.push({ operation: request.operation, identity, passed: false, status: response.status,
          ...(body?.report ? { report: body.report } : {}),
          ...(body?.detail ? { detail: body.detail } : {}) });
        break;
      }
      results.push({ operation: request.operation, identity, passed: true, status: response.status,
        report: body.report });
    } catch (error) {
      results.push({ operation: request.operation, identity, passed: false, status: null,
        error: error?.name || 'request_failed' });
      break;
    }
    if ((index + 1) % 50 === 0) process.stdout.write(`Completed ${index + 1}/${prepared.requests.length} admin requests.\n`);
  }
  return {
    total: prepared.requests.length,
    attempted: results.length,
    passed: results.filter(item => item.passed).length,
    failed: results.filter(item => !item.passed).length,
    completed: results.length === prepared.requests.length && results.every(item => item.passed),
    results,
  };
}

export { validatePrepared, executeRequests };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prepared || !args.evidence || !args.report) {
    fail('Usage: migrate-major-league-snapshot.mjs --prepared DIR --evidence FILE --report FILE [--execute --url URL]');
  }
  const prepared = validatePrepared(path.resolve(args.prepared), path.resolve(args.evidence));
  const execute = args.execute === true;
  if (execute && !args.url) fail('--url is required with --execute.');
  const execution = execute ? await executeRequests(prepared, {
    url: args.url,
    token: process.env.ADMIN_INGEST_TOKEN,
  }) : null;
  const report = {
    schemaVersion: 'jfw-d1-major-leagues-migration-client-report/1',
    mode: execute ? 'execute' : 'validate-only',
    source: prepared.source,
    validation: { passed: true, summary: prepared.summary, uploadObjects: prepared.uploadObjects },
    execution,
    passed: execute ? execution.completed : true,
    productionReady: false,
    publicReadFlagsChanged: false,
  };
  const reportPath = path.resolve(args.report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ mode: report.mode, ...prepared.summary, passed: report.passed })}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
