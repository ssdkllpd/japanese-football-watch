import {
  assertValidDateIndexPayload,
  competitionDateIndexR2Key,
  dateIndexR2Key,
} from '../shared/date-index-contract.mjs';
import { buildD1DateIndexesForPublication } from '../worker/index.mjs';
import { publishDateIndexCoverageFromR2 } from './date-index-coverage-ingest.mjs';

export const DATE_INDEX_REFRESH_OPERATION = 'date_index_refresh';

export function assertDateIndexRefreshRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'date,fixtureIds,operation,schemaVersion'
    || value.operation !== DATE_INDEX_REFRESH_OPERATION
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.date || ''))
    || new Date(`${value.date}T00:00:00Z`).toISOString().slice(0, 10) !== value.date
    || !Array.isArray(value.fixtureIds) || value.fixtureIds.length === 0
    || value.fixtureIds.length > 20
    || value.fixtureIds.some(id => !/^af:fixture:\d+$/.test(String(id)))
    || new Set(value.fixtureIds).size !== value.fixtureIds.length) {
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
  const { generic, competitions } = await buildD1DateIndexesForPublication(
    env, input.date, (prior.results || []).map(row => row.competition_id),
  );
  const currentIds = new Set(generic.fixtures.map(fixture => fixture.fixtureId));
  if (input.fixtureIds.some(id => !currentIds.has(id))) {
    throw new Error('Declared refreshed fixture is missing from the D1 date.');
  }
  const key = dateIndexR2Key(input.date);
  const existing = await env.FOOTBALL_DATA.get(key);
  if (existing) {
    const previous = JSON.parse(await existing.text());
    assertValidDateIndexPayload(previous, { expectedDate: input.date, expectedCompetitionId: null });
    if (previous.fixtures.some(fixture => !currentIds.has(fixture.fixtureId))) {
      throw new Error('Existing date index contains fixtures absent from D1; full publication is unsafe.');
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
