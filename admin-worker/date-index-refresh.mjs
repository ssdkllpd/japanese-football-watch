import {
  assertValidDateIndexPayload,
  competitionDateIndexR2Key,
  dateIndexR2Key,
} from '../shared/date-index-contract.mjs';
import { buildD1DateIndexesForPublication } from '../worker/index.mjs';
import { publishDateIndexCoverageFromR2 } from './date-index-coverage-ingest.mjs';

export const DATE_INDEX_REFRESH_OPERATION = 'date_index_refresh';

export function assertDateIndexRefreshRequest(value) {
  const keys = Object.keys(value || {}).sort().join(',');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['date,fixtureIds,operation,schemaVersion',
      'date,departedFixtures,fixtureIds,operation,schemaVersion',
      'date,fixtureIds,operation,scheduledDepartures,schemaVersion'].includes(keys)
    || value.operation !== DATE_INDEX_REFRESH_OPERATION
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.date || ''))
    || new Date(`${value.date}T00:00:00Z`).toISOString().slice(0, 10) !== value.date
    || !Array.isArray(value.fixtureIds)
    || value.fixtureIds.length > 20
    || value.fixtureIds.some(id => !/^af:fixture:\d+$/.test(String(id)))
    || new Set(value.fixtureIds).size !== value.fixtureIds.length
    || (value.departedFixtures !== undefined && (!Array.isArray(value.departedFixtures)
      || value.departedFixtures.length === 0 || value.departedFixtures.length > 20
      || value.departedFixtures.some(item => !item || typeof item !== 'object'
        || Object.keys(item).sort().join(',') !== 'date,fixtureId'
        || !/^af:fixture:\d+$/.test(String(item.fixtureId))
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.date))
        || new Date(`${item.date}T00:00:00Z`).toISOString().slice(0, 10) !== item.date
        || item.date === value.date)
      || new Set(value.departedFixtures.map(item => item.fixtureId)).size !== value.departedFixtures.length))
    || (value.scheduledDepartures !== undefined && (!Array.isArray(value.scheduledDepartures)
      || value.scheduledDepartures.length === 0 || value.scheduledDepartures.length > 20
      || value.scheduledDepartures.some(item => !item || typeof item !== 'object'
        || Object.keys(item).sort().join(',') !== 'date,fixtureId'
        || !/^af:fixture:\d+$/.test(String(item.fixtureId))
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.date))
        || new Date(`${item.date}T00:00:00Z`).toISOString().slice(0, 10) !== item.date
        || item.date === value.date)
      || new Set(value.scheduledDepartures.map(item => item.fixtureId)).size !== value.scheduledDepartures.length))
    || (value.fixtureIds.length === 0 && !value.departedFixtures?.length && !value.scheduledDepartures?.length)) {
    throw new Error('Admin date index refresh request is invalid.');
  }
  return value;
}

export async function refreshDateIndexesFromD1(env, request) {
  const input = assertDateIndexRefreshRequest(request);
  if (!env.FOOTBALL_DB || !env.FOOTBALL_DATA?.put) {
    throw new Error('Admin date index refresh bindings are unavailable.');
  }
  const prior = await env.FOOTBALL_DB.prepare(`
    SELECT competition.canonical_id AS competition_id
    FROM competition_date_index_coverages coverage
    JOIN competitions competition ON competition.id = coverage.competition_id
    WHERE coverage.date_jst = ?
  `).bind(input.date).all();
  const key = dateIndexR2Key(input.date);
  const existing = await env.FOOTBALL_DATA.get(key);
  const previous = existing ? JSON.parse(await existing.text()) : null;
  if (previous) assertValidDateIndexPayload(previous, {
    expectedDate: input.date, expectedCompetitionId: null,
  });
  const departed = new Map([...(input.departedFixtures || []), ...(input.scheduledDepartures || [])]
    .map(item => [item.fixtureId, item.date]));
  const departedCompetitions = [];
  for (const [fixtureId, destination] of departed) {
    const row = await env.FOOTBALL_DB.prepare(`
      SELECT fixture.date_jst, fixture.published_revision, revision.lifecycle_state,
        competition.canonical_id AS competition_id
      FROM fixtures fixture
      LEFT JOIN fixture_revisions revision ON revision.id = fixture.published_revision
        AND revision.fixture_id = fixture.id
      JOIN competition_seasons season ON season.id = fixture.competition_season_id
      JOIN competitions competition ON competition.id = season.competition_id
      WHERE fixture.canonical_id = ?
    `).bind(fixtureId).first();
    const scheduled = (input.scheduledDepartures || []).some(item => item.fixtureId === fixtureId);
    if (row?.date_jst !== destination
      || (scheduled ? row.published_revision !== null && row.lifecycle_state !== 'published'
        : row.lifecycle_state !== 'published')) {
      throw new Error('Declared relocated fixture is not on the destination date with the expected publication state.');
    }
    if (scheduled) {
      const checkpoint = await env.FOOTBALL_DB.prepare(`
        SELECT fixture_id FROM fixture_schedule_refresh_pending
        WHERE fixture_id = ? AND old_date_jst = ? AND new_date_jst = ?
      `).bind(fixtureId, input.date, destination).first();
      if (!checkpoint) throw new Error('Schedule departure lacks a durable pending repair.');
    }
    departedCompetitions.push(row.competition_id);
  }
  const { generic, competitions } = await buildD1DateIndexesForPublication(
    env, input.date, [
      ...(prior.results || []).map(row => row.competition_id),
      ...(previous?.fixtures || []).map(item => item.competitionId),
      ...departedCompetitions,
    ],
  );
  const currentIds = new Set(generic.fixtures.map(fixture => fixture.fixtureId));
  if (input.fixtureIds.some(id => !currentIds.has(id))) {
    throw new Error('Declared refreshed fixture is missing from the D1 date.');
  }
  if (previous) {
    const removed = previous.fixtures.filter(fixture => !currentIds.has(fixture.fixtureId));
    if (removed.some(fixture => !departed.has(fixture.fixtureId))) {
      throw new Error('Existing date index contains undeclared fixtures absent from D1; full publication is unsafe.');
    }
  }
  const artifacts = [
    { key, payload: generic },
    ...competitions.map(payload => ({
      key: competitionDateIndexR2Key(payload.competition.id, input.date), payload,
    })),
  ];
  const serialized = artifacts.map(artifact => ({
    key: artifact.key, json: `${JSON.stringify(artifact.payload)}\n`,
  }));
  const sizes = serialized.map(artifact => new TextEncoder().encode(artifact.json).byteLength);
  if (sizes.some(size => size > 4 * 1024 * 1024)
    || sizes.reduce((total, size) => total + size, 0) > 8 * 1024 * 1024) {
    throw new Error('Rebuilt date index exceeds the Admin Worker ingest limit.');
  }
  for (const artifact of serialized) {
    await env.FOOTBALL_DATA.put(artifact.key, artifact.json, {
      httpMetadata: { contentType: 'application/json' },
    });
  }
  const coverage = await publishDateIndexCoverageFromR2(env, {
    schemaVersion: input.schemaVersion,
    operation: 'date_index_coverage_publish',
    date: input.date,
    competitionIds: competitions.map(item => item.competition.id),
  });
  return { ...coverage, operation: DATE_INDEX_REFRESH_OPERATION };
}
