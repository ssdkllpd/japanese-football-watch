import { sha256Text } from './date-repair-control.mjs';
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
) {
    throw new Error('Admin date index refresh request is invalid.');
  }
  return value;
}

export async function refreshDateIndexesFromD1(env, request) {
  const input = assertDateIndexRefreshRequest(request);
  if (!env.FOOTBALL_DB || !env.FOOTBALL_DATA?.put) {
    throw new Error('Admin date index refresh bindings are unavailable.');
  }
  const journal = await env.FOOTBALL_DB.prepare('SELECT repair_token FROM date_index_repair_queue WHERE date_jst=?').bind(input.date).first();
  if (!journal && input.fixtureIds.length === 0 && !input.departedFixtures?.length && !input.scheduledDepartures?.length) {
    throw new Error('Empty refresh requires a durable date repair.');
  }
  const token = crypto.randomUUID();
  const markDirty = () => env.FOOTBALL_DB.prepare(`INSERT INTO date_index_repair_queue(date_jst,repair_token,changed_at)
    VALUES(?,?,?) ON CONFLICT(date_jst) DO UPDATE SET repair_token=excluded.repair_token,changed_at=excluded.changed_at`)
    .bind(input.date, token, new Date().toISOString()).run();
  const prior = await env.FOOTBALL_DB.prepare(`
    SELECT competition.canonical_id AS competition_id
    FROM competition_date_index_coverages coverage
    JOIN competitions competition ON competition.id = coverage.competition_id
    WHERE coverage.date_jst = ? AND coverage.fixture_count > 0
  `).bind(input.date).all();
  const key = dateIndexR2Key(input.date);
  const existing = await env.FOOTBALL_DATA.get(key);
  const rawPrevious=existing ? await existing.text() : null;
  const authorization=rawPrevious===null ? null : await env.FOOTBALL_DB.prepare(
    'SELECT orphan_ids_json,allow_invalid FROM date_index_repair_authorizations WHERE date_jst=? AND source_sha256=?'
  ).bind(input.date,await sha256Text(rawPrevious)).first();
  let previous=null;
  if(rawPrevious!==null) {
    try {previous=JSON.parse(rawPrevious);assertValidDateIndexPayload(previous,{expectedDate:input.date,expectedCompetitionId:null});}
    catch(error) {if(!authorization?.allow_invalid) throw error;previous=null;}
  }
  const authorizedOrphans=new Set(JSON.parse(authorization?.orphan_ids_json || '[]'));
  if(authorizedOrphans.size) {
    const known=await env.FOOTBALL_DB.prepare('SELECT canonical_id FROM fixtures WHERE canonical_id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify([...authorizedOrphans])).all();
    if(known.results.length) throw new Error('Approved orphan is now stored in D1; re-investigate the repair.');
  }
  const departed = new Map([...(input.departedFixtures || []), ...(input.scheduledDepartures || [])]
    .map(item => [item.fixtureId, item.date]));
  const departedCompetitions = [];
  const declaredRows = departed.size ? await env.FOOTBALL_DB.prepare(`
    SELECT fixture.canonical_id AS fixture_id,fixture.date_jst,fixture.published_revision,revision.lifecycle_state,
      competition.canonical_id AS competition_id FROM fixtures fixture
    LEFT JOIN fixture_revisions revision ON revision.id=fixture.published_revision AND revision.fixture_id=fixture.id
    JOIN competition_seasons season ON season.id=fixture.competition_season_id
    JOIN competitions competition ON competition.id=season.competition_id
    WHERE fixture.canonical_id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify([...departed.keys()])).all() : {results:[]};
  const declared = new Map(declaredRows.results.map(row=>[row.fixture_id,row]));
  const scheduledIds=new Set((input.scheduledDepartures || []).map(item=>item.fixtureId));
  const checkpoints = scheduledIds.size ? await env.FOOTBALL_DB.prepare(`
    SELECT fixture_id,new_date_jst FROM fixture_schedule_refresh_pending
    WHERE old_date_jst=? AND fixture_id IN (SELECT value FROM json_each(?))`)
    .bind(input.date,JSON.stringify([...scheduledIds])).all() : {results:[]};
  const checkpointDestinations=new Map(checkpoints.results.map(row=>[row.fixture_id,row.new_date_jst]));
  for (const [fixtureId,destination] of departed) {
    const row=declared.get(fixtureId);
    const scheduled=scheduledIds.has(fixtureId);
    if (row?.date_jst !== destination
      || (scheduled ? row.published_revision !== null && row.lifecycle_state !== 'published'
        : row.lifecycle_state !== 'published')) {
      throw new Error('Declared relocated fixture is not on the destination date with the expected publication state.');
    }
    if (scheduled && checkpointDestinations.get(fixtureId)!==destination) {
      throw new Error('Schedule departure lacks a durable pending repair.');
    }
    departedCompetitions.push(row.competition_id);
  }
  const retained = await env.FOOTBALL_DB.prepare(
    'SELECT competition_id FROM date_index_repair_scopes WHERE date_jst=?'
  ).bind(input.date).all();
  const { generic, competitions } = await buildD1DateIndexesForPublication(
    env, input.date, [
      ...(prior.results || []).map(row => row.competition_id),
      ...(previous?.fixtures || []).map(item => item.competitionId),
      ...departedCompetitions,
      ...(retained.results || []).map(row => row.competition_id),
    ],
  );
  const currentIds = new Set(generic.fixtures.map(fixture => fixture.fixtureId));
  if (input.fixtureIds.some(id => !currentIds.has(id))) {
    throw new Error('Declared refreshed fixture is missing from the D1 date.');
  }
  if (previous) {
    const removed = previous.fixtures.filter(fixture => !currentIds.has(fixture.fixtureId));
    const unknown=removed.filter(item=>!departed.has(item.fixtureId));
    const movedRows = journal && unknown.length ? await env.FOOTBALL_DB.prepare(
      'SELECT canonical_id,date_jst FROM fixtures WHERE canonical_id IN (SELECT value FROM json_each(?))'
    ).bind(JSON.stringify(unknown.map(item=>item.fixtureId))).all() : {results:[]};
    const moved=new Map(movedRows.results.map(row=>[row.canonical_id,row.date_jst]));
    for (const fixture of unknown) {
      const destination=moved.get(fixture.fixtureId);
      if (destination && destination!==input.date) departed.set(fixture.fixtureId,destination);
    }
    if (removed.some(fixture => !departed.has(fixture.fixtureId) && !authorizedOrphans.has(fixture.fixtureId))) {
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
  // Save the complete scope before the first R2 put. Empty scopes are retired only
  // after verified publication while this operation still owns the queue token.
  if (competitions.length > 24) throw new Error('Date repair exceeds the reviewed competition limit (24).');
  if (competitions.length) await env.FOOTBALL_DB.prepare(`INSERT INTO date_index_repair_scopes(date_jst,competition_id)
    SELECT ?,value FROM json_each(?) WHERE true ON CONFLICT(date_jst,competition_id) DO NOTHING`)
    .bind(input.date,JSON.stringify(competitions.map(item=>item.competition.id))).run();
  await markDirty();
  let coverage;
  try {
    for (const artifact of serialized) {
      await env.FOOTBALL_DATA.put(artifact.key, artifact.json, { httpMetadata: { contentType: 'application/json' } });
    }
    coverage = await publishDateIndexCoverageFromR2(env, { schemaVersion: input.schemaVersion,
      operation: 'date_index_coverage_publish', date: input.date,
      competitionIds: competitions.map(item => item.competition.id) });
    const fresh = await buildD1DateIndexesForPublication(env,input.date,competitions.map(item => item.competition.id));
    const comparable = payload => JSON.stringify(payload.fixtures);
    if (comparable(fresh.generic) !== comparable(generic)
      || fresh.competitions.some(item => comparable(item) !== comparable(competitions.find(c => c.competition.id===item.competition.id)))) {
      throw new Error('D1 date changed during index repair; retry the durable date queue.');
    }
    const emptyScopes=competitions.filter(item=>item.fixtures.length===0).map(item=>item.competition.id);
    if(emptyScopes.length) await env.FOOTBALL_DB.prepare(`DELETE FROM date_index_repair_scopes
      WHERE date_jst=? AND competition_id IN (SELECT value FROM json_each(?))
        AND EXISTS (SELECT 1 FROM date_index_repair_queue WHERE date_jst=? AND repair_token=?)
        AND NOT EXISTS (SELECT 1 FROM fixtures f JOIN competition_seasons s ON s.id=f.competition_season_id
          JOIN competitions c ON c.id=s.competition_id WHERE f.date_jst=date_index_repair_scopes.date_jst
            AND c.canonical_id=date_index_repair_scopes.competition_id)`)
      .bind(input.date,JSON.stringify(emptyScopes),input.date,token).run();
    await env.FOOTBALL_DB.prepare(`DELETE FROM date_index_repair_fixture_dates WHERE date_jst=?
      AND EXISTS (SELECT 1 FROM date_index_repair_queue WHERE date_jst=? AND repair_token=?)`)
      .bind(input.date,input.date,token).run();
    await env.FOOTBALL_DB.prepare('DELETE FROM date_index_repair_queue WHERE date_jst=? AND repair_token=?').bind(input.date,token).run();
  } catch (error) {
    // A stale repair may have written after a newer repair cleared its marker.
    // Always leave durable work, including failures after an R2 put.
    await markDirty();
    throw error;
  }
  return { ...coverage, operation: DATE_INDEX_REFRESH_OPERATION };
}
