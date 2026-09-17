#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fixtureImporterModule from './fixture-bundle-importer.js';
import { expectedState } from './check-major-league-partial-state.mjs';

const { correctionDefinitions } = fixtureImporterModule;
const MANIFEST_SCHEMA = 'jfw-d1-major-leagues-migration-manifest/1';
const EVIDENCE_SCHEMA = 'jfw-d1-major-leagues-reviewed-evidence/1';
const REQUEST_SCHEMA = 'jfw-d1-admin-ingest/1';
const RESUME_SCHEMA = 'jfw-d1-major-league-partial-state/1';
const MAX_REQUEST_ATTEMPTS = 6;
const MAX_EXECUTION_MILLISECONDS = 60 * 60 * 1_000;
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const RETRYABLE_ERROR_NAMES = new Set(['AbortError', 'TimeoutError', 'TypeError']);
const MAX_DIAGNOSTIC_LENGTH = 240;
const RESUME_STATE_KEYS = [
  'schemaVersion', 'state', 'passed', 'expectedFixtures', 'expectedDetails',
  'storedFixtures', 'matchedDetails', 'pendingFixtures', 'pendingDetails',
  'pendingUpgrades', 'matchedFixtureDetailIds', 'pendingFixtureDetailIds',
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
  const expectedDetails = expectedState(root).details;
  const fixtureExpectations = [...expectedDetails.entries()].map(([fixtureId, detail]) => ({
    fixtureId, revisionNo: detail.revision, contentSha256: detail.contentSha256,
  })).sort((left, right) => (left.fixtureId < right.fixtureId ? -1 : left.fixtureId > right.fixtureId ? 1 : 0));
  const sortedCompletedFixtureIds = [...completedFixtureIds].sort();
  if (fixtureExpectations.length !== sortedCompletedFixtureIds.length
    || fixtureExpectations.some((item, index) => item.fixtureId !== sortedCompletedFixtureIds[index])) {
    fail('Prepared fixture expectations do not exactly cover completed fixture details.');
  }
  requests.push({
    schemaVersion: REQUEST_SCHEMA,
    operation: 'migration_verify',
    snapshotId: source.snapshotId,
    archiveSha256: source.archiveSha256,
    fixedSnapshot: null,
    fixtureIds: completedFixtureIds,
    fixtureExpectations,
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

function boundedDiagnostic(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function responseDiagnostics(response, raw, body) {
  const contentType = boundedDiagnostic(response.headers.get('content-type'));
  const cfRay = boundedDiagnostic(response.headers.get('cf-ray'));
  const retryAfter = boundedDiagnostic(response.headers.get('retry-after'));
  return {
    responseBodyBytes: Buffer.byteLength(raw),
    responseBodySha256: createHash('sha256').update(raw).digest('hex'),
    responseBodyKind: raw.length === 0 ? 'empty' : body ? 'json' : 'non_json',
    ...(contentType ? { responseContentType: contentType } : {}),
    ...(cfRay ? { cfRay } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    ...(boundedDiagnostic(body?.error) ? { serviceError: boundedDiagnostic(body.error) } : {}),
    ...(boundedDiagnostic(body?.detail) ? { detail: boundedDiagnostic(body.detail) } : {}),
  };
}

function failureReportDiagnostics(report) {
  if (report === undefined || report === null) return {};
  const raw = JSON.stringify(report);
  return {
    failureReportBytes: Buffer.byteLength(raw),
    failureReportSha256: createHash('sha256').update(raw).digest('hex'),
    ...(boundedDiagnostic(report?.schemaVersion)
      ? { failureReportSchemaVersion: boundedDiagnostic(report.schemaVersion) } : {}),
    ...(boundedDiagnostic(report?.operation)
      ? { failureReportOperation: boundedDiagnostic(report.operation) } : {}),
  };
}

function retryDelay(response, attempt, nowMilliseconds = Date.now()) {
  const retryAfterHeader = response?.headers?.get('retry-after');
  const retryAfter = Number(retryAfterHeader);
  if (retryAfterHeader !== null && retryAfterHeader !== undefined && retryAfterHeader !== ''
    && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1_000, 30_000);
  }
  const retryAt = Date.parse(retryAfterHeader || '');
  if (Number.isFinite(retryAt)) {
    return Math.min(Math.max(0, retryAt - nowMilliseconds), 30_000);
  }
  return Math.min(1_000 * (2 ** (attempt - 1)), 30_000);
}

function executionBudgetFailure(
  request, identity, attempts, retryHistory, status = null, diagnostics = {},
) {
  return {
    operation: request.operation, identity, passed: false, status,
    attempts, error: 'ExecutionBudgetExceeded', ...diagnostics,
    ...(retryHistory.length ? { retryHistory } : {}),
  };
}

async function executeRequest(url, request, identity, options) {
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now || Date.now;
  const retryHistory = [];
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    if (now() >= options.deadline) {
      return executionBudgetFailure(request, identity, attempt - 1, retryHistory);
    }
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(60_000, options.deadline - now()))),
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      const raw = await response.text();
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* classified below */ }
      if (response.ok && body?.ok === true) {
        return {
          operation: request.operation, identity, passed: true, status: response.status,
          attempts: attempt, report: body.report,
          ...(retryHistory.length ? { retryHistory } : {}),
        };
      }
      const diagnostics = responseDiagnostics(response, raw, body);
      if (RETRYABLE_HTTP_STATUSES.has(response.status) && attempt < MAX_REQUEST_ATTEMPTS) {
        retryHistory.push({ attempt, status: response.status, ...diagnostics });
        const delay = retryDelay(response, attempt, now());
        if (now() + delay >= options.deadline) {
          return executionBudgetFailure(
            request, identity, attempt, retryHistory, response.status, diagnostics,
          );
        }
        process.stdout.write(`Retrying ${request.operation} ${identity} after HTTP ${response.status} `
          + `(attempt ${attempt + 1}/${MAX_REQUEST_ATTEMPTS}).\n`);
        await sleep(delay);
        continue;
      }
      return {
        operation: request.operation, identity, passed: false, status: response.status,
        attempts: attempt,
        ...failureReportDiagnostics(body?.report),
        ...diagnostics,
        ...(retryHistory.length ? { retryHistory } : {}),
      };
    } catch (error) {
      const errorName = error?.name || 'request_failed';
      if (RETRYABLE_ERROR_NAMES.has(errorName) && attempt < MAX_REQUEST_ATTEMPTS) {
        retryHistory.push({ attempt, error: errorName });
        const delay = retryDelay(null, attempt, now());
        if (now() + delay >= options.deadline) {
          return executionBudgetFailure(request, identity, attempt, retryHistory);
        }
        process.stdout.write(`Retrying ${request.operation} ${identity} after ${errorName} `
          + `(attempt ${attempt + 1}/${MAX_REQUEST_ATTEMPTS}).\n`);
        await sleep(delay);
        continue;
      }
      return {
        operation: request.operation, identity, passed: false, status: null,
        attempts: attempt, error: errorName,
        ...(retryHistory.length ? { retryHistory } : {}),
      };
    }
  }
  throw new Error('Unreachable request retry state.');
}

async function executeRequests(prepared, options) {
  if (!options.token) fail('ADMIN_INGEST_TOKEN is required for execution.');
  const url = endpoint(options.url);
  const now = options.now || Date.now;
  const maxExecutionMilliseconds = options.maxExecutionMilliseconds ?? MAX_EXECUTION_MILLISECONDS;
  if (!Number.isSafeInteger(maxExecutionMilliseconds) || maxExecutionMilliseconds <= 0) {
    fail('maxExecutionMilliseconds must be a positive safe integer.');
  }
  const deadline = now() + maxExecutionMilliseconds;
  const results = [];
  for (const [index, request] of prepared.requests.entries()) {
    const identity = requestIdentity(request);
    const result = await executeRequest(url, request, identity, { ...options, now, deadline });
    results.push(result);
    if (!result.passed) break;
    if ((index + 1) % 50 === 0) process.stdout.write(`Completed ${index + 1}/${prepared.requests.length} admin requests.\n`);
  }
  return {
    total: prepared.requests.length,
    attempted: results.length,
    passed: results.filter(item => item.passed).length,
    failed: results.filter(item => !item.passed).length,
    completed: results.length === prepared.requests.length && results.every(item => item.passed),
    maxExecutionMilliseconds,
    results,
  };
}

export { validatePrepared, executeRequests };

function sortedUniqueStrings(values, label) {
  if (!Array.isArray(values)
    || values.some(value => typeof value !== 'string' || !/^af:fixture:\d+$/.test(value))) {
    fail(`${label} must be an array of canonical fixture IDs.`);
  }
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) fail(`${label} contains duplicates.`);
  if (JSON.stringify(values) !== JSON.stringify(sorted)) fail(`${label} must be sorted.`);
  return sorted;
}

export function applyResumeState(prepared, resumeState) {
  if (!resumeState || typeof resumeState !== 'object' || Array.isArray(resumeState)) {
    fail('D1 resume state must be an object.');
  }
  const unknownKeys = Object.keys(resumeState).filter(key => !RESUME_STATE_KEYS.includes(key));
  if (unknownKeys.length) {
    fail(`D1 resume state contains unknown fields: ${unknownKeys.join(', ')}.`);
  }
  if (resumeState?.schemaVersion !== RESUME_SCHEMA || resumeState.passed !== true
    || !['clean', 'compatible-partial', 'complete'].includes(resumeState.state)) {
    fail('D1 resume state is unsupported or did not pass validation.');
  }
  const fixtureRequests = prepared.requests.filter(request => request.operation === 'fixture_migration_publish');
  const expectedFixtureIds = fixtureRequests.map(request => request.fixtureId).sort();
  const matchedFixtureIds = sortedUniqueStrings(
    resumeState.matchedFixtureDetailIds, 'matchedFixtureDetailIds',
  );
  const pendingFixtureIds = sortedUniqueStrings(
    resumeState.pendingFixtureDetailIds, 'pendingFixtureDetailIds',
  );
  const partition = [...matchedFixtureIds, ...pendingFixtureIds].sort();
  if (JSON.stringify(partition) !== JSON.stringify(expectedFixtureIds)
    || resumeState.expectedFixtures !== prepared.summary.coreFixtures
    || resumeState.storedFixtures + resumeState.pendingFixtures !== resumeState.expectedFixtures
    || resumeState.expectedDetails !== expectedFixtureIds.length
    || resumeState.matchedDetails !== matchedFixtureIds.length
    || resumeState.pendingDetails !== pendingFixtureIds.length
    || resumeState.matchedDetails + resumeState.pendingDetails !== resumeState.expectedDetails
    || !Number.isInteger(resumeState.pendingUpgrades) || resumeState.pendingUpgrades < 0
    || resumeState.pendingUpgrades > resumeState.pendingDetails
    || (resumeState.state === 'clean' && (resumeState.storedFixtures !== 0 || matchedFixtureIds.length !== 0))
    || (resumeState.state === 'complete'
      && (resumeState.pendingFixtures !== 0 || pendingFixtureIds.length !== 0))
    || (resumeState.state === 'compatible-partial'
      && resumeState.pendingFixtures === 0 && pendingFixtureIds.length === 0)) {
    fail('D1 resume state does not exactly partition the prepared fixture details.');
  }
  const matched = new Set(matchedFixtureIds);
  const requests = prepared.requests.filter(request => (
    request.operation !== 'fixture_migration_publish' || !matched.has(request.fixtureId)
  ));
  const requiredArtifactKeys = new Set(requests.map(request => request.artifactKey).filter(Boolean));
  const uploadObjects = prepared.uploadObjects.filter(item => requiredArtifactKeys.has(item.r2Key));
  if (uploadObjects.length !== requiredArtifactKeys.size) {
    fail('D1 resume plan cannot resolve every required content-addressed artifact.');
  }
  return {
    ...prepared,
    requests,
    uploadObjects,
    resume: {
      schemaVersion: RESUME_SCHEMA,
      state: resumeState.state,
      passed: true,
      matchedFixtureDetails: matchedFixtureIds.length,
      pendingFixtureDetails: pendingFixtureIds.length,
    },
    summary: {
      ...prepared.summary,
      authoritativeAdminRequests: prepared.summary.adminRequests,
      authoritativeUploadObjects: prepared.summary.uploadObjects,
      adminRequests: requests.length,
      uploadObjects: uploadObjects.length,
      skippedFixtureDetails: matchedFixtureIds.length,
      pendingFixtureDetails: pendingFixtureIds.length,
    },
  };
}

function validationResult(prepared) {
  const requestPlanCountValid = prepared.resume
    ? prepared.requests.length === prepared.summary.authoritativeAdminRequests
      - prepared.summary.skippedFixtureDetails
    : prepared.requests.length === prepared.summary.adminRequests;
  const uploadPlanCountValid = prepared.resume
    ? prepared.uploadObjects.length === prepared.summary.authoritativeUploadObjects
      - prepared.summary.skippedFixtureDetails
    : prepared.uploadObjects.length === prepared.summary.uploadObjects;
  const checks = {
    sourcePinned: prepared.source?.provider === 'api-football'
      && /^[0-9a-f]{64}$/.test(String(prepared.source?.archiveSha256 || '')),
    requestPlanCountValid,
    uploadPlanCountValid,
    requestsNonEmpty: prepared.requests.length > 0,
    uploadObjectsNonEmpty: prepared.uploadObjects.length > 0,
    uploadHashesValid: prepared.uploadObjects.every(item => /^[0-9a-f]{64}$/.test(item.sha256)),
    resumeStateValid: !prepared.resume || prepared.resume.passed === true,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export { validationResult };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prepared || !args.evidence || !args.report) {
    fail('Usage: migrate-major-league-snapshot.mjs --prepared DIR --evidence FILE --report FILE '
      + '[--resume-state FILE] [--execute --url URL]');
  }
  const fullPrepared = validatePrepared(path.resolve(args.prepared), path.resolve(args.evidence));
  const prepared = args['resume-state']
    ? applyResumeState(fullPrepared, readJson(path.resolve(args['resume-state']), 'D1 resume state'))
    : fullPrepared;
  const validation = validationResult(prepared);
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
    validation: {
      ...validation, summary: prepared.summary, uploadObjects: prepared.uploadObjects,
      ...(prepared.resume ? { resume: prepared.resume } : {}),
    },
    execution,
    passed: validation.passed && (!execute || execution.completed),
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
