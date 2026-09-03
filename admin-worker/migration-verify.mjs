import { fixedSnapshotR2Key } from '../shared/fixed-snapshot-contract.mjs';

export const MIGRATION_VERIFY_OPERATION = 'migration_verify';

const MAX_FIXTURES = 500;
const MAX_STANDINGS = 100;
const MAX_DATES = 64;
const MAX_COMPETITION_SCOPES = 1_000;
const EXPECTED_TOTAL_KEYS = [
  'fixedSnapshots', 'publishedFixtures', 'publishedStandings',
  'dateIndexCoverages', 'competitionDateIndexCoverages',
];

function compareCodePoint(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonical(value, expression, label) {
  if (typeof value !== 'string' || !expression.test(value)) throw new Error(`${label} is invalid.`);
}

function realDate(value, label) {
  canonical(value, /^\d{4}-\d{2}-\d{2}$/, label);
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a real date.`);
  }
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates.`);
}

function requireArray(value, label, limit) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > limit) throw new Error(`${label} exceeds its limit (${value.length}/${limit}).`);
}

function normalizeExpectedTotals(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expectedTotals must be an object or null.');
  }
  const keys = Object.keys(value).sort(compareCodePoint);
  const expectedKeys = [...EXPECTED_TOTAL_KEYS].sort(compareCodePoint);
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`expectedTotals must declare exactly: ${EXPECTED_TOTAL_KEYS.join(', ')}.`);
  }
  for (const key of EXPECTED_TOTAL_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error(`expectedTotals.${key} must be a non-negative safe integer.`);
    }
  }
  return Object.fromEntries(EXPECTED_TOTAL_KEYS.map(key => [key, value[key]]));
}

export function assertMigrationVerifyRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Admin migration verification request must be an object.');
  }
  const allowed = new Set([
    'schemaVersion', 'operation', 'fixedSnapshot', 'fixtureIds', 'standings', 'dateIndexCoverages',
    'expectedTotals',
  ]);
  const unknown = Object.keys(input).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Admin migration verification request contains unknown fields: ${unknown.join(', ')}.`);
  if (input.operation !== MIGRATION_VERIFY_OPERATION) throw new Error('Admin migration verification operation is invalid.');
  requireArray(input.fixtureIds, 'fixtureIds', MAX_FIXTURES);
  requireArray(input.standings, 'standings', MAX_STANDINGS);
  requireArray(input.dateIndexCoverages, 'dateIndexCoverages', MAX_DATES);
  if (!Object.hasOwn(input, 'expectedTotals')) {
    throw new Error('expectedTotals must be declared explicitly.');
  }
  const expectedTotals = normalizeExpectedTotals(input.expectedTotals);

  let fixedSnapshot = null;
  if (input.fixedSnapshot !== null) {
    if (!input.fixedSnapshot || typeof input.fixedSnapshot !== 'object'
      || Array.isArray(input.fixedSnapshot)) throw new Error('fixedSnapshot must be an object or null.');
    const fixedAllowed = new Set(['artifactSha256', 'productSeasonId']);
    const fixedUnknown = Object.keys(input.fixedSnapshot).filter(key => !fixedAllowed.has(key));
    if (fixedUnknown.length) throw new Error(`fixedSnapshot contains unknown fields: ${fixedUnknown.join(', ')}.`);
    canonical(input.fixedSnapshot.artifactSha256, /^[0-9a-f]{64}$/, 'fixedSnapshot.artifactSha256');
    canonical(input.fixedSnapshot.productSeasonId, /^jfw:season:\d{4}-\d{2}$/,
      'fixedSnapshot.productSeasonId');
    fixedSnapshot = { ...input.fixedSnapshot };
  }

  const fixtureIds = [...input.fixtureIds].sort(compareCodePoint);
  fixtureIds.forEach((fixtureId, index) => canonical(
    fixtureId, /^af:fixture:\d+$/, `fixtureIds[${index}]`,
  ));
  unique(fixtureIds, 'fixtureIds');

  const standings = input.standings.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`standings[${index}] must be an object.`);
    }
    const itemAllowed = new Set(['competitionId', 'seasonId']);
    const itemUnknown = Object.keys(item).filter(key => !itemAllowed.has(key));
    if (itemUnknown.length) throw new Error(`standings[${index}] contains unknown fields: ${itemUnknown.join(', ')}.`);
    canonical(item.competitionId, /^af:competition:\d+$/, `standings[${index}].competitionId`);
    canonical(item.seasonId, /^af:season:\d+:\d+$/, `standings[${index}].seasonId`);
    return { competitionId: item.competitionId, seasonId: item.seasonId };
  }).sort((left, right) => compareCodePoint(left.competitionId, right.competitionId)
    || compareCodePoint(left.seasonId, right.seasonId));
  unique(standings.map(item => `${item.competitionId}\t${item.seasonId}`), 'standings');

  let competitionScopeCount = 0;
  const dateIndexCoverages = input.dateIndexCoverages.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`dateIndexCoverages[${index}] must be an object.`);
    }
    const itemAllowed = new Set(['date', 'competitionIds']);
    const itemUnknown = Object.keys(item).filter(key => !itemAllowed.has(key));
    if (itemUnknown.length) throw new Error(`dateIndexCoverages[${index}] contains unknown fields: ${itemUnknown.join(', ')}.`);
    realDate(item.date, `dateIndexCoverages[${index}].date`);
    requireArray(item.competitionIds, `dateIndexCoverages[${index}].competitionIds`, 24);
    const competitionIds = [...item.competitionIds].sort(compareCodePoint);
    competitionIds.forEach((competitionId, competitionIndex) => canonical(
      competitionId, /^af:competition:\d+$/,
      `dateIndexCoverages[${index}].competitionIds[${competitionIndex}]`,
    ));
    unique(competitionIds, `dateIndexCoverages[${index}].competitionIds`);
    competitionScopeCount += competitionIds.length;
    return { date: item.date, competitionIds };
  }).sort((left, right) => compareCodePoint(left.date, right.date));
  unique(dateIndexCoverages.map(item => item.date), 'dateIndexCoverages');
  if (competitionScopeCount > MAX_COMPETITION_SCOPES) {
    throw new Error(`dateIndexCoverages exceeds the competition scope limit (${competitionScopeCount}/${MAX_COMPETITION_SCOPES}).`);
  }
  if (!fixedSnapshot && fixtureIds.length + standings.length + dateIndexCoverages.length === 0) {
    throw new Error('Admin migration verification scope is empty.');
  }
  return { ...input, fixedSnapshot, fixtureIds, standings, dateIndexCoverages, expectedTotals };
}

async function rows(database, sql, params = []) {
  const result = await database.prepare(sql).bind(...params).all();
  return result.results || [];
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function verifyFixedSnapshot(database, declaration) {
  if (!declaration) return { expected: false, verified: true };
  const found = await rows(database, `
    SELECT raw.content_sha256, raw.r2_key
    FROM raw_snapshots raw
    WHERE raw.content_sha256 = ? AND raw.r2_key = ?
      AND EXISTS (SELECT 1 FROM product_seasons WHERE canonical_id = ?)
      AND EXISTS (
        SELECT 1 FROM sync_runs sync
        WHERE sync.run_type = 'fixed_snapshot_import' AND sync.code_revision = raw.content_sha256
          AND sync.status = 'completed'
      )
      AND EXISTS (
        SELECT 1 FROM record_sources source_record
        WHERE source_record.raw_snapshot_id = raw.id
          AND source_record.fact_kind = 'fixed_snapshot'
          AND source_record.fact_key = raw.content_sha256
      )
      AND EXISTS (
        SELECT 1 FROM tracked_player_aggregates aggregate_row
        JOIN product_seasons season ON season.id = aggregate_row.product_season_id
        WHERE season.canonical_id = ? AND aggregate_row.aggregate_scope = 'season'
      )
  `, [declaration.artifactSha256, fixedSnapshotR2Key(declaration.artifactSha256),
    declaration.productSeasonId, declaration.productSeasonId]);
  return {
    expected: true,
    artifactSha256: declaration.artifactSha256,
    productSeasonId: declaration.productSeasonId,
    verified: found.length === 1,
  };
}

async function verifiedFixtureIds(database, fixtureIds) {
  const found = [];
  for (const group of chunks(fixtureIds, 50)) {
    const result = await rows(database, `
      SELECT fixture.canonical_id
      FROM fixtures fixture
      JOIN fixture_revisions revision ON revision.id = fixture.published_revision
        AND revision.fixture_id = fixture.id
      WHERE fixture.canonical_id IN (${group.map(() => '?').join(', ')})
        AND revision.lifecycle_state = 'published'
        AND revision.published_at IS NOT NULL
    `, group);
    found.push(...result.map(row => row.canonical_id));
  }
  return new Set(found);
}

async function verifiedStandings(database, declarations) {
  const found = [];
  for (const group of chunks(declarations, 40)) {
    if (!group.length) continue;
    const predicates = group.map(() => '(competition.canonical_id = ? AND season.canonical_id = ?)');
    const result = await rows(database, `
      SELECT competition.canonical_id AS competition_id, season.canonical_id AS season_id
      FROM standings_publications publication
      JOIN competition_seasons season ON season.id = publication.competition_season_id
      JOIN competitions competition ON competition.id = season.competition_id
      WHERE ${predicates.join(' OR ')}
    `, group.flatMap(item => [item.competitionId, item.seasonId]));
    found.push(...result);
  }
  return new Set(found.map(item => `${item.competition_id}\t${item.season_id}`));
}

async function migrationTotals(database, expected) {
  if (!expected) return { expected: null, actual: null, mismatches: [] };
  const [actual = {}] = await rows(database, `
    SELECT
      (SELECT COUNT(*) FROM raw_snapshots
        WHERE retention_class = 'migration-fixed-snapshot') AS fixedSnapshots,
      (SELECT COUNT(*) FROM fixtures fixture
        JOIN fixture_revisions revision ON revision.id = fixture.published_revision
          AND revision.fixture_id = fixture.id
        WHERE revision.lifecycle_state = 'published' AND revision.published_at IS NOT NULL
      ) AS publishedFixtures,
      (SELECT COUNT(*) FROM standings_publications) AS publishedStandings,
      (SELECT COUNT(*) FROM date_index_coverages) AS dateIndexCoverages,
      (SELECT COUNT(*) FROM competition_date_index_coverages) AS competitionDateIndexCoverages
  `);
  const normalized = Object.fromEntries(EXPECTED_TOTAL_KEYS.map(key => [key, Number(actual[key])]));
  const mismatches = EXPECTED_TOTAL_KEYS
    .filter(key => expected[key] !== normalized[key])
    .map(key => ({ key, expected: expected[key], actual: normalized[key] }));
  return { expected, actual: normalized, mismatches };
}

async function verifiedDateCoverages(database, dates) {
  if (!dates.length) return { generic: new Set(), competitions: new Map() };
  const dateValues = dates.map(item => item.date);
  const genericRows = await rows(database, `
    SELECT date_jst FROM date_index_coverages
    WHERE date_jst IN (${dateValues.map(() => '?').join(', ')})
  `, dateValues);
  const competitionRows = await rows(database, `
    SELECT coverage.date_jst, competition.canonical_id AS competition_id
    FROM competition_date_index_coverages coverage
    JOIN competitions competition ON competition.id = coverage.competition_id
    WHERE coverage.date_jst IN (${dateValues.map(() => '?').join(', ')})
    ORDER BY coverage.date_jst, competition.canonical_id
  `, dateValues);
  const competitions = new Map(dateValues.map(date => [date, []]));
  for (const row of competitionRows) competitions.get(row.date_jst).push(row.competition_id);
  return { generic: new Set(genericRows.map(row => row.date_jst)), competitions };
}

export async function verifyMigrationState(env, request) {
  if (!env.FOOTBALL_DB) throw new Error('Admin ingest D1 binding is unavailable.');
  const input = assertMigrationVerifyRequest(request);
  const fixedSnapshot = await verifyFixedSnapshot(env.FOOTBALL_DB, input.fixedSnapshot);
  const fixtures = await verifiedFixtureIds(env.FOOTBALL_DB, input.fixtureIds);
  const standings = await verifiedStandings(env.FOOTBALL_DB, input.standings);
  const dateCoverages = await verifiedDateCoverages(env.FOOTBALL_DB, input.dateIndexCoverages);
  const totals = await migrationTotals(env.FOOTBALL_DB, input.expectedTotals);

  const missingFixtureIds = input.fixtureIds.filter(fixtureId => !fixtures.has(fixtureId));
  const missingStandings = input.standings.filter(item => !standings.has(
    `${item.competitionId}\t${item.seasonId}`,
  ));
  const missingDateIndexes = input.dateIndexCoverages
    .filter(item => !dateCoverages.generic.has(item.date))
    .map(item => item.date);
  const competitionScopeMismatches = input.dateIndexCoverages.flatMap(item => {
    if (!dateCoverages.generic.has(item.date)) return [];
    const actual = dateCoverages.competitions.get(item.date) || [];
    return actual.length === item.competitionIds.length
      && actual.every((value, index) => value === item.competitionIds[index])
      ? [] : [{ date: item.date, expected: item.competitionIds, actual }];
  });
  const passed = fixedSnapshot.verified && missingFixtureIds.length === 0
    && missingStandings.length === 0 && missingDateIndexes.length === 0
    && competitionScopeMismatches.length === 0 && totals.mismatches.length === 0;
  return {
    schemaVersion: 'jfw-d1-admin-ingest-report/1',
    operation: MIGRATION_VERIFY_OPERATION,
    passed,
    fixedSnapshot,
    fixtureCount: input.fixtureIds.length,
    standingsCount: input.standings.length,
    dateIndexCoverageCount: input.dateIndexCoverages.length,
    competitionDateCoverageCount: input.dateIndexCoverages.reduce(
      (count, item) => count + item.competitionIds.length, 0,
    ),
    missingFixtureIds,
    missingStandings,
    missingDateIndexes,
    competitionScopeMismatches,
    expectedTotals: totals.expected,
    actualTotals: totals.actual,
    totalMismatches: totals.mismatches,
    productionReady: false,
  };
}
