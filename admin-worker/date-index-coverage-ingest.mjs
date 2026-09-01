import {
  assertValidDateIndexPayload,
  compareCodePoint,
  competitionDateIndexR2Key,
  dateIndexR2Key,
  fixtureIdDigestInput,
} from '../shared/date-index-contract.mjs';

export const DATE_INDEX_COVERAGE_OPERATION = 'date_index_coverage_publish';
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
  const unknown = Object.keys(input).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Admin date index coverage request contains unknown fields: ${unknown.join(', ')}.`);
  if (input.operation !== DATE_INDEX_COVERAGE_OPERATION || !realDate(input.date)
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
