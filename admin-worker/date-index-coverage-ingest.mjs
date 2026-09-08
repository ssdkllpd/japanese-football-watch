import {
  assertValidDateIndexPayload,
  compareCodePoint,
  competitionDateIndexR2Key,
  dateIndexR2Key,
  fixtureIdDigestInput,
} from '../shared/date-index-contract.mjs';

export const DATE_INDEX_COVERAGE_OPERATION = 'date_index_coverage_publish';
export const MAJOR_LEAGUE_DATE_COVERAGE_OPERATION = 'major_league_date_coverage_publish';
const MAJOR_LEAGUE_DATE_COVERAGE_SCHEMA = 'jfw-d1-major-league-date-coverage-artifact/1';
const MAX_COMPETITION_INDEXES = 24;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 8 * 1024 * 1024;

function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

export function assertDateIndexCoverageRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Admin date index coverage request must be an object.');
  }
  const allowed = new Set(['schemaVersion', 'operation', 'date', 'competitionIds']);
  if (input.operation === MAJOR_LEAGUE_DATE_COVERAGE_OPERATION) {
    for (const key of ['snapshotId', 'archiveSha256', 'artifactKey', 'artifactSha256']) {
      allowed.add(key);
    }
  }
  const unknown = Object.keys(input).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Admin date index coverage request contains unknown fields: ${unknown.join(', ')}.`);
  if (![DATE_INDEX_COVERAGE_OPERATION, MAJOR_LEAGUE_DATE_COVERAGE_OPERATION].includes(input.operation)
    || !realDate(input.date)
    || !Array.isArray(input.competitionIds)) {
    throw new Error('Admin date index coverage scope is invalid.');
  }
  if (input.competitionIds.length > MAX_COMPETITION_INDEXES) {
    throw new Error(`Admin date index coverage exceeds the competition limit (${input.competitionIds.length}/${MAX_COMPETITION_INDEXES}).`);
  }
  for (const competitionId of input.competitionIds) {
    if (!/^af:competition:\d+$/.test(String(competitionId || ''))) {
      throw new Error('Admin date index coverage contains an invalid competition ID.');
    }
  }
  const competitionIds = [...input.competitionIds].sort(compareCodePoint);
  if (new Set(competitionIds).size !== competitionIds.length) {
    throw new Error('Admin date index coverage contains duplicate competition IDs.');
  }
  if (input.operation === MAJOR_LEAGUE_DATE_COVERAGE_OPERATION) {
    if (!/^\d{8}-\d{9}Z$/.test(String(input.snapshotId || ''))
      || !/^[0-9a-f]{64}$/.test(String(input.archiveSha256 || ''))
      || !/^[0-9a-f]{64}$/.test(String(input.artifactSha256 || ''))) {
      throw new Error('Major-league date coverage source declaration is invalid.');
    }
    const expectedKey = `migration/api-football/v3/major-leagues/2026/${input.archiveSha256}`
      + `/date-coverages-${input.artifactSha256}.json`;
    if (input.artifactKey !== expectedKey) {
      throw new Error('Major-league date coverage artifact key is not content-addressed in the reviewed prefix.');
    }
  }
  return { ...input, competitionIds };
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function statement(database, sql, params = []) {
  return database.prepare(sql).bind(...params);
}

async function rows(database, sql, params = []) {
  const result = await database.prepare(sql).bind(...params).all();
  return result.results || [];
}

function sortedUnique(values, label) {
  const result = [...values].sort(compareCodePoint);
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate fixture IDs.`);
  return result;
}

function sameIds(expected, actual, label) {
  const left = sortedUnique(expected, `${label} artifact`);
  const right = sortedUnique(actual, `${label} D1`);
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${label} fixture identity set does not match D1.`);
  }
}

function sameFixtureScopes(artifactFixtures, storedFixtures, label) {
  const stored = new Map(storedFixtures.map(fixture => [fixture.fixture_id, fixture]));
  for (const fixture of artifactFixtures) {
    const row = stored.get(fixture.fixtureId);
    if (!row || row.competition_id !== fixture.competitionId || row.season_id !== fixture.seasonId) {
      throw new Error(`${label} fixture scope does not match D1: ${fixture.fixtureId}.`);
    }
  }
}

async function fixtureDigest(ids) {
  return sha256(fixtureIdDigestInput(ids.map(fixtureId => ({ fixtureId }))));
}

async function readArtifact(bucket, key, expected) {
  const object = await bucket.get(key);
  if (!object) {
    const error = new Error(`Date index R2 object is missing: ${key}.`);
    error.status = 404;
    throw error;
  }
  const raw = await object.text();
  const byteSize = new TextEncoder().encode(raw).byteLength;
  if (byteSize > MAX_ARTIFACT_BYTES) throw new Error(`Date index R2 object exceeds the ingest limit: ${key}.`);
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error(`Date index R2 object is not JSON: ${key}.`); }
  assertValidDateIndexPayload(payload, expected);
  return { key, raw, byteSize, payload, sha256: await sha256(raw) };
}

function exactFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}.`);
}

function canonicalIds(values, expression, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`);
  values.forEach((value, index) => {
    if (typeof value !== 'string' || !expression.test(value)) {
      throw new Error(`${label}[${index}] is invalid.`);
    }
  });
  const sorted = [...values].sort(compareCodePoint);
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} contains duplicates.`);
  if (sorted.some((value, index) => value !== values[index])) {
    throw new Error(`${label} must be sorted.`);
  }
  return sorted;
}

async function readMajorLeagueCoverageArtifact(bucket, input) {
  const object = await bucket.get(input.artifactKey);
  if (!object) {
    const error = new Error('Major-league date coverage migration artifact is missing.');
    error.status = 404;
    throw error;
  }
  const raw = await object.text();
  const byteSize = new TextEncoder().encode(raw).byteLength;
  if (byteSize > MAX_ARTIFACT_BYTES) {
    throw new Error('Major-league date coverage migration artifact exceeds the ingest limit.');
  }
  if (await sha256(raw) !== input.artifactSha256) {
    throw new Error('Major-league date coverage migration artifact hash mismatch.');
  }
  let artifact;
  try { artifact = JSON.parse(raw); } catch {
    throw new Error('Major-league date coverage migration artifact is not JSON.');
  }
  exactFields(artifact, new Set(['schemaVersion', 'source', 'dates']), 'date coverage artifact');
  if (artifact.schemaVersion !== MAJOR_LEAGUE_DATE_COVERAGE_SCHEMA || !Array.isArray(artifact.dates)) {
    throw new Error('Major-league date coverage migration artifact schema is invalid.');
  }
  exactFields(artifact.source, new Set([
    'provider', 'apiVersion', 'snapshotId', 'archiveKey', 'archiveSha256',
    'archiveByteSize', 'observedAt',
  ]), 'date coverage artifact source');
  let observedAt = null;
  try { observedAt = new Date(artifact.source.observedAt).toISOString(); } catch { /* rejected below */ }
  if (artifact.source.provider !== 'api-football' || artifact.source.apiVersion !== 'v3'
    || artifact.source.snapshotId !== input.snapshotId
    || artifact.source.archiveSha256 !== input.archiveSha256
    || artifact.source.archiveKey
      !== `audit/api-football/v3/major-leagues/2026/snapshots/${input.snapshotId}.tar.gz`
    || !Number.isSafeInteger(artifact.source.archiveByteSize) || artifact.source.archiveByteSize < 0
    || observedAt !== artifact.source.observedAt) {
    throw new Error('Major-league date coverage migration source is invalid.');
  }
  if (artifact.dates.length === 0 || artifact.dates.length > 500) {
    throw new Error('Major-league date coverage artifact exceeds the date bounds.');
  }
  const dates = artifact.dates.map((dateItem, dateIndex) => {
    exactFields(dateItem, new Set([
      'date', 'fixtureIds', 'fixtureIdDigest', 'competitions',
    ]), `date coverage artifact dates[${dateIndex}]`);
    if (!realDate(dateItem.date) || !Array.isArray(dateItem.competitions)) {
      throw new Error(`date coverage artifact dates[${dateIndex}] is invalid.`);
    }
    const fixtureIds = canonicalIds(
      dateItem.fixtureIds, /^af:fixture:\d+$/,
      `date coverage artifact dates[${dateIndex}].fixtureIds`,
    );
    const competitions = dateItem.competitions.map((competition, competitionIndex) => {
      exactFields(competition, new Set([
        'competitionId', 'fixtureIds', 'fixtureIdDigest',
      ]), `date coverage artifact dates[${dateIndex}].competitions[${competitionIndex}]`);
      if (!/^af:competition:\d+$/.test(String(competition.competitionId || ''))) {
        throw new Error('Major-league date coverage competition ID is invalid.');
      }
      return {
        ...competition,
        fixtureIds: canonicalIds(
          competition.fixtureIds, /^af:fixture:\d+$/,
          `date coverage artifact dates[${dateIndex}].competitions[${competitionIndex}].fixtureIds`,
        ),
      };
    });
    const competitionIds = competitions.map(item => item.competitionId);
    canonicalIds(competitionIds, /^af:competition:\d+$/,
      `date coverage artifact dates[${dateIndex}].competitions`);
    const scopedIds = competitions.flatMap(item => item.fixtureIds).sort(compareCodePoint);
    if (scopedIds.length !== fixtureIds.length
      || scopedIds.some((value, index) => value !== fixtureIds[index])) {
      throw new Error(`Major-league date coverage competition partition is incomplete for ${dateItem.date}.`);
    }
    return { ...dateItem, fixtureIds, competitions };
  });
  canonicalIds(dates.map(item => item.date), /^\d{4}-\d{2}-\d{2}$/,
    'date coverage artifact dates');
  const selected = dates.find(item => item.date === input.date);
  if (!selected) throw new Error('Declared date is absent from the major-league coverage artifact.');
  if (selected.competitions.length !== input.competitionIds.length
    || selected.competitions.some((item, index) => item.competitionId !== input.competitionIds[index])) {
    throw new Error('Declared competition scopes differ from the major-league coverage artifact.');
  }
  if (await fixtureDigest(selected.fixtureIds) !== selected.fixtureIdDigest) {
    throw new Error('Major-league generic date coverage digest is invalid.');
  }
  for (const competition of selected.competitions) {
    if (await fixtureDigest(competition.fixtureIds) !== competition.fixtureIdDigest) {
      throw new Error(`Major-league competition date coverage digest is invalid: ${competition.competitionId}.`);
    }
  }
  return { artifact, selected, raw, byteSize };
}

async function storedScope(database, date, competitionIds) {
  const fixtures = await rows(database, `
    SELECT fixture.canonical_id AS fixture_id, competition.canonical_id AS competition_id,
      season.canonical_id AS season_id
    FROM fixtures fixture
    JOIN competition_seasons season ON season.id = fixture.competition_season_id
    JOIN competitions competition ON competition.id = season.competition_id
    WHERE fixture.date_jst = ?
    ORDER BY fixture.canonical_id
  `, [date]);
  let competitions = [];
  if (competitionIds.length) {
    competitions = await rows(database, `
      SELECT id, canonical_id FROM competitions
      WHERE canonical_id IN (${competitionIds.map(() => '?').join(', ')})
      ORDER BY canonical_id
    `, competitionIds);
  }
  const storedCompetitionIds = competitions.map(row => row.canonical_id);
  if (storedCompetitionIds.length !== competitionIds.length
    || storedCompetitionIds.some((value, index) => value !== competitionIds[index])) {
    throw new Error('A declared date index competition is not stored in D1.');
  }
  const required = [...new Set(fixtures.map(row => row.competition_id))].sort(compareCodePoint);
  const omitted = required.filter(competitionId => !competitionIds.includes(competitionId));
  if (omitted.length) {
    throw new Error(`Date index coverage omits competitions with fixtures on ${date}: ${omitted.join(', ')}.`);
  }
  return { competitions, fixtures };
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function coverageStatements(database, date, generic, competitions) {
  const statements = [
    statement(database, `
      INSERT INTO date_index_coverages(
        date_jst, fixture_count, fixture_id_digest, generated_at, source_r2_key, source_sha256
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date_jst) DO UPDATE SET
        fixture_count = excluded.fixture_count,
        fixture_id_digest = excluded.fixture_id_digest,
        generated_at = excluded.generated_at,
        source_r2_key = excluded.source_r2_key,
        source_sha256 = excluded.source_sha256
    `, [date, generic.fixtureIds.length, generic.fixtureIdDigest, generic.payload.generatedAt,
      generic.key, generic.sha256]),
    statement(database, 'DELETE FROM competition_date_index_coverages WHERE date_jst = ?', [date]),
  ];
  for (const group of chunks(competitions, 10)) {
    statements.push(statement(database, `
      INSERT INTO competition_date_index_coverages(
        competition_id, date_jst, fixture_count, fixture_id_digest,
        generated_at, source_r2_key, source_sha256
      ) VALUES ${group.map(() => `(
        (SELECT id FROM competitions WHERE canonical_id = ?), ?, ?, ?, ?, ?, ?
      )`).join(', ')}
    `, group.flatMap(item => [item.competitionId, date, item.fixtureIds.length,
      item.fixtureIdDigest, item.payload.generatedAt, item.key, item.sha256])));
  }
  statements.push(statement(database, `
    INSERT INTO sync_runs(run_type, started_at, finished_at, status, requests_used, code_revision)
    VALUES (
      'date_index_coverage_integrity_assertion',
      CASE WHEN
        (SELECT COUNT(*) FROM date_index_coverages
          WHERE date_jst = ? AND fixture_count = ? AND fixture_id_digest = ?
            AND generated_at = ? AND source_r2_key = ? AND source_sha256 = ?) = 1
        AND (SELECT COUNT(*) FROM competition_date_index_coverages WHERE date_jst = ?) = ?
      THEN ? ELSE 'date_index_coverage_integrity_failure' END,
      ?, 'completed', 0, ?
    )
  `, [date, generic.fixtureIds.length, generic.fixtureIdDigest, generic.payload.generatedAt,
    generic.key, generic.sha256, date, competitions.length, generic.payload.generatedAt,
    generic.payload.generatedAt, generic.sha256]));
  statements.push(statement(database, `
    DELETE FROM sync_runs
    WHERE run_type = 'date_index_coverage_integrity_assertion' AND code_revision = ?
  `, [generic.sha256]));
  return statements;
}

export async function publishDateIndexCoverageFromR2(env, request) {
  if (!env.FOOTBALL_DB || !env.FOOTBALL_DATA) throw new Error('Admin ingest bindings are unavailable.');
  const input = assertDateIndexCoverageRequest(request);
  const genericPromise = readArtifact(env.FOOTBALL_DATA, dateIndexR2Key(input.date), {
    expectedDate: input.date, expectedCompetitionId: null,
  });
  // Carry the externally declared competition ID alongside the artifact. Reading
  // it back out of the payload would re-derive the scope from the same document
  // the scope is meant to constrain, so a weakened payload validator would
  // silently mis-attribute coverage instead of failing.
  const competitionPromises = input.competitionIds.map(async competitionId => ({
    declaredCompetitionId: competitionId,
    ...await readArtifact(
      env.FOOTBALL_DATA, competitionDateIndexR2Key(competitionId, input.date), {
        expectedDate: input.date, expectedCompetitionId: competitionId,
      },
    ),
  }));
  const [genericArtifact, competitionArtifacts] = await Promise.all([
    genericPromise, Promise.all(competitionPromises),
  ]);
  const totalBytes = genericArtifact.byteSize
    + competitionArtifacts.reduce((total, artifact) => total + artifact.byteSize, 0);
  if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) throw new Error('Date index artifacts exceed the total ingest limit.');

  const scope = await storedScope(env.FOOTBALL_DB, input.date, input.competitionIds);
  const genericStoredIds = scope.fixtures.map(row => row.fixture_id);
  const genericFixtureIds = genericArtifact.payload.fixtures.map(fixture => fixture.fixtureId);
  sameIds(genericFixtureIds, genericStoredIds, `generic date ${input.date}`);
  sameFixtureScopes(genericArtifact.payload.fixtures, scope.fixtures, `generic date ${input.date}`);
  const generic = {
    ...genericArtifact,
    fixtureIds: genericStoredIds,
    fixtureIdDigest: await fixtureDigest(genericStoredIds),
  };
  const competitions = [];
  for (const artifact of competitionArtifacts) {
    const competitionId = artifact.declaredCompetitionId;
    if (artifact.payload.competition?.id !== competitionId) {
      throw new Error(`Date index artifact competition differs from the declared scope: ${competitionId}.`);
    }
    const storedIds = scope.fixtures
      .filter(row => row.competition_id === competitionId)
      .map(row => row.fixture_id);
    const artifactIds = artifact.payload.fixtures.map(fixture => fixture.fixtureId);
    sameIds(artifactIds, storedIds, `competition date ${competitionId}/${input.date}`);
    sameFixtureScopes(artifact.payload.fixtures,
      scope.fixtures.filter(row => row.competition_id === competitionId),
      `competition date ${competitionId}/${input.date}`);
    competitions.push({
      ...artifact,
      competitionId,
      fixtureIds: storedIds,
      fixtureIdDigest: await fixtureDigest(storedIds),
    });
  }
  const statements = coverageStatements(env.FOOTBALL_DB, input.date, generic, competitions);
  await env.FOOTBALL_DB.batch(statements);
  return {
    schemaVersion: 'jfw-d1-admin-ingest-report/1',
    operation: DATE_INDEX_COVERAGE_OPERATION,
    date: input.date,
    generic: {
      fixtureCount: generic.fixtureIds.length,
      fixtureIdDigest: generic.fixtureIdDigest,
      sourceR2Key: generic.key,
      sourceSha256: generic.sha256,
    },
    competitions: competitions.map(item => ({
      competitionId: item.competitionId,
      fixtureCount: item.fixtureIds.length,
      fixtureIdDigest: item.fixtureIdDigest,
      sourceR2Key: item.key,
      sourceSha256: item.sha256,
    })),
    undeclaredCompetitions: [],
    productionReady: false,
  };
}

export async function publishMajorLeagueDateCoverageFromR2(env, request) {
  if (!env.FOOTBALL_DB || !env.FOOTBALL_DATA) throw new Error('Admin ingest bindings are unavailable.');
  const input = assertDateIndexCoverageRequest(request);
  if (input.operation !== MAJOR_LEAGUE_DATE_COVERAGE_OPERATION) {
    throw new Error('Major-league date coverage operation is invalid.');
  }
  const loaded = await readMajorLeagueCoverageArtifact(env.FOOTBALL_DATA, input);
  const scope = await storedScope(env.FOOTBALL_DB, input.date, input.competitionIds);
  const storedIds = scope.fixtures.map(item => item.fixture_id);
  sameIds(loaded.selected.fixtureIds, storedIds, `major-league generic date ${input.date}`);
  const generic = {
    key: input.artifactKey,
    sha256: input.artifactSha256,
    payload: { generatedAt: loaded.artifact.source.observedAt },
    fixtureIds: storedIds,
    fixtureIdDigest: await fixtureDigest(storedIds),
  };
  const competitions = loaded.selected.competitions.map(item => {
    const competitionStoredIds = scope.fixtures
      .filter(row => row.competition_id === item.competitionId)
      .map(row => row.fixture_id);
    sameIds(item.fixtureIds, competitionStoredIds,
      `major-league competition date ${item.competitionId}/${input.date}`);
    return {
      competitionId: item.competitionId,
      key: input.artifactKey,
      sha256: input.artifactSha256,
      payload: { generatedAt: loaded.artifact.source.observedAt },
      fixtureIds: competitionStoredIds,
      fixtureIdDigest: item.fixtureIdDigest,
    };
  });
  await env.FOOTBALL_DB.batch(coverageStatements(
    env.FOOTBALL_DB, input.date, generic, competitions,
  ));
  return {
    schemaVersion: 'jfw-d1-admin-ingest-report/1',
    operation: MAJOR_LEAGUE_DATE_COVERAGE_OPERATION,
    snapshotId: input.snapshotId,
    archiveSha256: input.archiveSha256,
    artifactKey: input.artifactKey,
    artifactSha256: input.artifactSha256,
    date: input.date,
    fixtureCount: storedIds.length,
    fixtureIdDigest: generic.fixtureIdDigest,
    competitionCount: competitions.length,
    productionReady: false,
  };
}
