import { assertValidDateIndexPayload, dateIndexR2Key } from '../shared/date-index-contract.mjs';
import { readFixturePublishBudget } from './fixture-publish-budget.mjs';
import { canonicalFixtureHashes } from './fixture-ingest.mjs';

export const FIXTURE_CORRECTION_GUARD_OPERATION = 'fixture_correction_guard';

export function assertFixtureCorrectionGuardRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',')
      !== 'competitionId,date,fixtureId,operation,schemaVersion,seasonId'
    || value.operation !== FIXTURE_CORRECTION_GUARD_OPERATION
    || !/^af:fixture:\d+$/.test(String(value.fixtureId || ''))
    || !/^af:competition:\d+$/.test(String(value.competitionId || ''))
    || !/^af:season:\d+:\d+$/.test(String(value.seasonId || ''))
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.date || ''))
    || Number.isNaN(Date.parse(`${value.date}T00:00:00Z`))
    || new Date(`${value.date}T00:00:00Z`).toISOString().slice(0, 10) !== value.date) {
    throw new Error('Automation fixture correction guard request is invalid.');
  }
  return value;
}

export async function verifyStoredFixtureCorrections(env, request) {
  const input = assertFixtureCorrectionGuardRequest(request);
  if (!env.FOOTBALL_DB || !env.FOOTBALL_DATA) throw new Error('Admin fixture guard bindings are unavailable.');
  const scope = await env.FOOTBALL_DB.prepare(`
    SELECT canonical_id AS fixture_id, date_jst,
      (SELECT COALESCE(MAX(revision_no), 0) FROM fixture_revisions
       WHERE fixture_id = fixtures.id) AS latest_revision,
      (SELECT content_sha256 FROM fixture_revisions
       WHERE id = fixtures.published_revision) AS published_hash
    FROM fixtures
    WHERE date_jst = ? OR canonical_id = ?
  `).bind(input.date, input.fixtureId).all();
  if ((scope.results || []).some(row => row.fixture_id === input.fixtureId
    && row.date_jst !== input.date)) {
    throw new Error('Automation fixture changed its stored JST date; publication is blocked.');
  }
  const storedIds = new Set((scope.results || [])
    .filter(row => row.date_jst === input.date).map(row => row.fixture_id));
  const oldIndex = await env.FOOTBALL_DATA.get(dateIndexR2Key(input.date));
  if (oldIndex) {
    const previous = JSON.parse(await oldIndex.text());
    assertValidDateIndexPayload(previous, { expectedDate: input.date, expectedCompetitionId: null });
    if (previous.fixtures.some(item => item.fixtureId !== input.fixtureId
      && !storedIds.has(item.fixtureId))) {
      throw new Error('Existing date index has fixtures absent from D1; publication is blocked.');
    }
  }
  const stored = await env.FOOTBALL_DB.prepare(`
    SELECT field_path FROM correction_states
    WHERE target_kind = 'fixture' AND target_canonical_id = ?
  `).bind(input.fixtureId).all();
  const required = (stored.results || []).map(row => row.field_path);
  const latestRevision = Number((scope.results || [])
    .find(row => row.fixture_id === input.fixtureId)?.latest_revision ?? 0);
  if (!Number.isSafeInteger(latestRevision) || latestRevision < 0) {
    throw new Error('Stored D1 fixture revision is invalid.');
  }
  const budget = await readFixturePublishBudget(env);
  const alreadyPublishedToday = budget.fixtureIds.includes(input.fixtureId);
  if (!alreadyPublishedToday && budget.remaining === 0) {
    throw new Error('D1 fixture publication daily cap reached; publication is blocked.');
  }
  const sameDayPublishedHash = alreadyPublishedToday
    ? (scope.results || []).find(row => row.fixture_id === input.fixtureId)?.published_hash : null;
  if (alreadyPublishedToday && !/^[0-9a-f]{64}$/.test(sameDayPublishedHash || '')) {
    throw new Error('D1 fixture publication receipt lacks its published content hash.');
  }
  let sameDayCanonicalHash = null;
  if (required.length || alreadyPublishedToday) {
    const key = `football/v2/competitions/${input.competitionId}`
      + `/seasons/${input.seasonId}/fixtures/${input.fixtureId}.json`;
    const current = await env.FOOTBALL_DATA.get(key);
    if (!current) throw new Error('Published fixture or stored manual corrections have no canonical R2 fixture; publication is blocked.');
    let payload;
    try { payload = JSON.parse(await current.text()); } catch {
      throw new Error('Canonical R2 fixture with stored corrections is invalid JSON.');
    }
    if (payload?.fixture?.id !== input.fixtureId
      || payload.fixture.competitionId !== input.competitionId
      || payload.fixture.seasonId !== input.seasonId
      || required.some(fieldPath => !Object.hasOwn(payload.overrides || {}, fieldPath))) {
      throw new Error('Canonical R2 fixture omits stored manual corrections; publication is blocked.');
    }
    if (alreadyPublishedToday) {
      const hashes = await canonicalFixtureHashes(env, input, payload);
      if (hashes.publishedHash !== sameDayPublishedHash) {
        throw new Error('Canonical R2 fixture differs from today’s published D1 revision.');
      }
      sameDayCanonicalHash = hashes.canonicalHash;
    }
  }
  return { schemaVersion: 'jfw-d1-admin-ingest-report/1',
    operation: FIXTURE_CORRECTION_GUARD_OPERATION, fixtureId: input.fixtureId,
    preservedCorrections: required.length, latestRevision,
    sameDayCanonicalHash };
}
