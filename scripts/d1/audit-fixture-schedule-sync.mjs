import { createHash } from 'node:crypto';
import { assertValidDateIndexPayload } from '../../shared/date-index-contract.mjs';

export const jstDate = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10);
const digest = ids => createHash('sha256').update(`${[...ids].sort().join('\n')}\n`).digest('hex');
const fields = ['fixture_id', 'competition_id', 'season_id', 'kickoff_utc', 'date_jst',
  'status_short', 'status_long', 'status_elapsed', 'ingestion_state', 'published_revision',
  'teams_json', 'score_json', 'competition_json'];
const labels = { NS: 'Not Started', TBD: 'Time to be defined', PST: 'Postponed',
  CANC: 'Cancelled', ABD: 'Abandoned', AWD: 'Technical Loss', WO: 'Walkover',
  SUSP: 'Match Suspended', INT: 'Match Interrupted' };
function identityMap(rows, label) {
  if (!Array.isArray(rows)) throw new Error(`${label} is missing.`);
  const map = new Map();
  for (const row of rows) {
    if (!/^af:fixture:\d+$/.test(row.fixture_id) || map.has(row.fixture_id)
      || fields.some(field => !Object.hasOwn(row, field))) throw new Error(`${label} is incomplete or duplicated.`);
    map.set(row.fixture_id, row);
  }
  return map;
}
export function affectedScheduleScopes(changes, before, after) {
  const dates = new Set(changes.flatMap(item => [jstDate(item.oldKickoffUtc), jstDate(item.newKickoffUtc)]));
  const scopes = new Map();
  for (const date of [...dates].sort()) {
    scopes.set(`all/${date}`, { date, competitionId: null });
    const competitions = new Set([...before, ...after].filter(row => row.date_jst === date)
      .map(row => row.competition_id));
    for (const item of changes) if ([jstDate(item.oldKickoffUtc), jstDate(item.newKickoffUtc)].includes(date)) competitions.add(item.competitionId);
    for (const competitionId of [...competitions].sort()) scopes.set(`${competitionId}/${date}`, { date, competitionId });
  }
  return scopes;
}
function sameJson(left,right) {
  const stable = value => value && typeof value === 'object'
    ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])) : value;
  return JSON.stringify(stable(left))===JSON.stringify(stable(right));
}
function verifyPayload(payload, scope, rows, label, corrections, competitionHeaders) {
  assertValidDateIndexPayload(payload, { expectedDate: scope.date, expectedCompetitionId: scope.competitionId });
  if(scope.competitionId && !sameJson(payload.competition,competitionHeaders.get(scope.competitionId))) {
    throw new Error(`${label} competition header differs from D1.`);
  }
  const actual = new Map(payload.fixtures.map(item => [item.fixtureId, item]));
  if (actual.size !== rows.length) throw new Error(`${label} fixture count differs from D1.`);
  for (const row of rows) {
    const item = actual.get(row.fixture_id);
    const expected = { status: { short:row.status_short,long:row.status_long,elapsed:row.status_elapsed },
      teams: JSON.parse(row.teams_json), score: JSON.parse(row.score_json) };
    for (const side of ['home','away']) {
      const winner=expected.teams[side].winner;
      expected.teams[side].winner=winner===null ? null : Boolean(winner);
    }
    for (const correction of corrections.filter(c => c.target_canonical_id === row.fixture_id && c.status === 'active')
      .sort((a,b)=>a.field_path.localeCompare(b.field_path))) {
      const parts=correction.field_path.split('.');
      if (parts.shift()!=='fixture' || !['status','teams','score'].includes(parts[0])) continue;
      let target=expected;
      for (const part of parts.slice(0,-1)) {
        if (!target || !Object.hasOwn(target,part)) throw new Error('Audit correction path is invalid.');
        target=target[part];
      }
      if (!target || !Object.hasOwn(target,parts.at(-1))) throw new Error('Audit correction path is invalid.');
      target[parts.at(-1)]=JSON.parse(correction.applied_value_json);
    }
    if (!item || item.kickoffUtc !== new Date(row.kickoff_utc).toISOString()
      || item.dateJst !== row.date_jst || item.competitionId !== row.competition_id
      || item.seasonId !== row.season_id || item.status.short !== expected.status.short
      || item.status.long !== expected.status.long || item.status.elapsed !== expected.status.elapsed
      || item.ingestionState !== row.ingestion_state
      || !sameJson(item.teams,expected.teams) || !sameJson(item.score,expected.score)
      || !sameJson(item.competition,JSON.parse(row.competition_json))
      || item.competitionName !== JSON.parse(row.competition_json).name) throw new Error(`${label} payload differs from D1: ${row.fixture_id}.`);
  }
}
export function auditScheduleSync({ changes, before, after, pending, genericCoverages,
  competitionCoverages, r2, publicSamples, inventoryEnd, corrections = [], dateRepairs = [],
  pendingEnd = pending, dateRepairsEnd = dateRepairs }) {
  if (!Array.isArray(changes) || !Array.isArray(pending) || !Array.isArray(pendingEnd)) throw new Error('Schedule changes or pending repair evidence is invalid.');
  if (!Array.isArray(dateRepairs) || !Array.isArray(dateRepairsEnd)) throw new Error('Date repair queue evidence is invalid.');
  if (!Array.isArray(corrections)) throw new Error('Correction evidence is invalid.');
  const original = identityMap(before, 'Before inventory');
  const current = identityMap(after, 'After inventory');
  const ending = identityMap(inventoryEnd, 'End inventory');
  const competitionHeaders = new Map([...current.values()].map(row=>[row.competition_id,JSON.parse(row.competition_json)]));
  const changed = new Map(changes.map(item => [item.fixtureId, item]));
  if (changed.size !== changes.length || current.size !== original.size || ending.size !== current.size) throw new Error('Audit fixture identities differ.');
  const scopes = affectedScheduleScopes(changes, before, after);
  const affectedDates = new Set([...scopes.values()].map(scope => scope.date));
  const isolatedPendingRepairs = [], isolatedDateRepairs = [];
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
  for (const [stage, checkpoints, queue] of [['initial',pending,dateRepairs],['final',pendingEnd,dateRepairsEnd]]) {
    for (const row of checkpoints) {
      if (!row || !/^af:fixture:\d+$/.test(row.fixture_id)) throw new Error('Pending repair evidence is invalid.');
      if (changed.has(row.fixture_id)) throw new Error('A selected fixture repair remains pending.');
      let registered;
      try { registered = JSON.parse(row.registered_dates_json); } catch { throw new Error('Pending repair date evidence is invalid.'); }
      if (!Array.isArray(registered) || !validDate(row.old_date_jst) || !validDate(row.new_date_jst)
        || registered.some(date => !validDate(date))) throw new Error('Pending repair date evidence is invalid.');
      const dates = [row.old_date_jst,row.new_date_jst,...registered,
        original.get(row.fixture_id)?.date_jst,current.get(row.fixture_id)?.date_jst];
      if (dates.some(date => affectedDates.has(date))) throw new Error('An affected date repair remains pending.');
      isolatedPendingRepairs.push({stage,...row});
    }
    for (const row of queue) {
      if (!row || !validDate(row.date_jst)) throw new Error('Date repair queue evidence is invalid.');
      if (affectedDates.has(row.date_jst)) throw new Error('Affected date repair queue is not empty.');
      isolatedDateRepairs.push({stage,...row});
    }
  }
  for (const [id, prior] of original) {
    const row = current.get(id);
    const end = ending.get(id);
    if (!row || !end || fields.some(field => row[field] !== end[field])) throw new Error(`Inventory changed during audit: ${id}.`);
    const change = changed.get(id);
    if (!change) {
      if (fields.some(field => prior[field] !== row[field])) throw new Error(`Unselected or held fixture was changed: ${id}.`);
      continue;
    }
    if (['teams_json','score_json','competition_json'].some(field=>prior[field]!==row[field])) throw new Error(`Selected fixture changed unrelated content: ${id}.`);
    if (prior.kickoff_utc !== change.oldKickoffUtc || prior.status_short !== change.oldStatus
      || prior.published_revision !== null || row.published_revision !== null
      || row.kickoff_utc !== new Date(change.newKickoffUtc).toISOString()
      || row.date_jst !== jstDate(change.newKickoffUtc) || row.status_short !== change.newStatus
      || row.status_long !== labels[change.newStatus] || row.status_elapsed !== null
      || row.ingestion_state !== 'scheduled' || row.competition_id !== change.competitionId
      || row.season_id !== change.seasonId) throw new Error(`Selected fixture differs from the declared change: ${id}.`);
  }
  if ([...changed.keys()].some(id => !original.has(id))) throw new Error('A selected fixture is absent from the baseline.');
  const generic = new Map(genericCoverages.map(row => [row.date_jst, row]));
  const competitions = new Map(competitionCoverages.map(row => [`${row.competition_id}/${row.date_jst}`, row]));
  for (const [key, scope] of scopes) {
    const rows = after.filter(row => row.date_jst === scope.date && (!scope.competitionId || row.competition_id === scope.competitionId));
    const coverage = scope.competitionId ? competitions.get(key) : generic.get(scope.date);
    if (!coverage || coverage.fixture_count !== rows.length || coverage.fixture_id_digest !== digest(rows.map(row => row.fixture_id))) throw new Error(`Coverage differs from all-competition D1 inventory: ${key}.`);
    if (!Object.hasOwn(r2 || {}, key)) throw new Error(`R2 evidence is missing: ${key}.`);
    verifyPayload(r2[key], scope, rows, `R2 ${key}`, corrections, competitionHeaders);
  }
  if (!Array.isArray(publicSamples) || (scopes.size && publicSamples.length === 0)) throw new Error('Public Worker samples are missing.');
  const sampled = new Set();
  for (const sample of publicSamples) {
    const scope = scopes.get(sample.scope);
    if (!scope || sampled.has(sample.scope) || sample.status !== 200) throw new Error('Public Worker sample failed or is outside the audit.');
    sampled.add(sample.scope);
    verifyPayload(sample.payload, scope, after.filter(row => row.date_jst === scope.date
      && (!scope.competitionId || row.competition_id === scope.competitionId)), `Public ${sample.scope}`, corrections, competitionHeaders);
  }
  return { schemaVersion: 'jfw-schedule-audit-report/3', passed: true,
    auditScope: 'affected_dates_and_changed_fixtures',
    overallPassed: isolatedPendingRepairs.length === 0 && isolatedDateRepairs.length === 0,
    isolatedPendingRepairs, isolatedDateRepairs,
    verifiedChanges: changes.length, verifiedPreservedFixtures: original.size - changes.length,
    verifiedR2Scopes: scopes.size, verifiedPublicSamples: publicSamples.length,
    pendingRepairs: 0, providerFreshnessVerified: false, browserUiVerified: false };
}
