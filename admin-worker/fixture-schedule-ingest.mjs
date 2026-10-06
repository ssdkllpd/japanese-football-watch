import { refreshDateIndexesFromD1 } from './date-index-refresh.mjs';

export const SCHEDULE_UPDATE_OPERATION = 'fixture_schedule_update';
export const SCHEDULE_REPAIR_OPERATION = 'fixture_schedule_repair';
const VERSION = 'jfw-d1-admin-ingest/1';
const NON_FINAL = new Set(['NS', 'TBD', 'PST', 'CANC', 'ABD', 'AWD', 'WO', 'SUSP', 'INT']);
const STATUS_LABELS = { NS: 'Not Started', TBD: 'Time to be defined', PST: 'Postponed',
  CANC: 'Cancelled', ABD: 'Abandoned', AWD: 'Technical Loss', WO: 'Walkover',
  SUSP: 'Match Suspended', INT: 'Match Interrupted' };

function utc(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z');
}

function dateJst(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function assertScheduleRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== VERSION) throw new Error('Schedule request is invalid.');
  if (value.operation === SCHEDULE_REPAIR_OPERATION
    && Object.keys(value).sort().join(',') === 'operation,schemaVersion') return value;
  if (value.operation !== SCHEDULE_UPDATE_OPERATION
    || Object.keys(value).sort().join(',') !== 'competitionId,fixtureId,newKickoffUtc,newStatus,oldKickoffUtc,oldStatus,operation,schemaVersion,seasonId'
    || !/^af:fixture:\d+$/.test(value.fixtureId)
    || !/^af:competition:\d+$/.test(value.competitionId)
    || !/^af:season:\d+:\d+$/.test(value.seasonId)
    || value.seasonId.split(':')[2] !== value.competitionId.split(':')[2]
    || !utc(value.oldKickoffUtc) || !utc(value.newKickoffUtc)
    || !NON_FINAL.has(value.oldStatus) || !NON_FINAL.has(value.newStatus)
    || (value.oldKickoffUtc === value.newKickoffUtc && value.oldStatus === value.newStatus)) {
    throw new Error('Schedule update identity or non-final state is invalid.');
  }
  return value;
}

async function pending(database) {
  const result = await database.prepare(`SELECT fixture_id, old_date_jst, new_date_jst, repair_token, registered_dates_json
    FROM fixture_schedule_refresh_pending ORDER BY changed_at, fixture_id LIMIT 1`).first();
  return result || null;
}

export async function repairFixtureSchedule(env) {
  const database = env.FOOTBALL_DB;
  const record = await pending(database);
  if (!record) {
    const queued = await database.prepare('SELECT date_jst FROM date_index_repair_queue ORDER BY changed_at,date_jst LIMIT 1').first();
    if (!queued) return { operation: SCHEDULE_REPAIR_OPERATION, repaired: null };
    await refreshDateIndexesFromD1(env, { schemaVersion: VERSION, operation: 'date_index_refresh', date: queued.date_jst, fixtureIds: [] });
    return { operation: SCHEDULE_REPAIR_OPERATION, repaired: `date:${queued.date_jst}` };
  }
  const row = await database.prepare(`SELECT fixture.date_jst, fixture.published_revision, revision.lifecycle_state
    FROM fixtures fixture LEFT JOIN fixture_revisions revision
      ON revision.id = fixture.published_revision AND revision.fixture_id = fixture.id
    WHERE fixture.canonical_id = ?`).bind(record.fixture_id).first();
  if (!row || (row.published_revision !== null && row.lifecycle_state !== 'published')) {
    throw new Error('Pending schedule repair differs from the stored fixture.');
  }
  // Include the intermediate destination and current date after a later writer moved it again.
  const dates = [...new Set([record.old_date_jst, record.new_date_jst, row.date_jst])];
  const registered = JSON.parse(record.registered_dates_json);
  const additions = dates.filter(date => !registered.includes(date));
  if (additions.length) {
    const token=crypto.randomUUID();
    await database.batch([
      database.prepare(`INSERT INTO date_index_repair_queue(date_jst,repair_token,changed_at)
        SELECT value,?,? FROM json_each(?) WHERE true
        ON CONFLICT(date_jst) DO NOTHING`).bind(token,new Date().toISOString(),JSON.stringify(additions)),
      database.prepare(`UPDATE fixture_schedule_refresh_pending SET registered_dates_json=?
        WHERE fixture_id=? AND repair_token=?`).bind(JSON.stringify([...new Set([...registered,...dates])]),record.fixture_id,record.repair_token),
    ]);
  }
  // One date per invocation keeps legacy A->B->C recovery within the D1 budget.
  const queued = await database.prepare(`SELECT date_jst FROM date_index_repair_queue
    WHERE date_jst IN (SELECT value FROM json_each(?)) ORDER BY changed_at,date_jst LIMIT 1`)
    .bind(JSON.stringify(dates)).first();
  if (queued) await refreshDateIndexesFromD1(env, { schemaVersion: VERSION, operation:'date_index_refresh',date:queued.date_jst,fixtureIds:[] });
  const remaining = await database.prepare(`SELECT date_jst FROM date_index_repair_queue
    WHERE date_jst IN (SELECT value FROM json_each(?)) LIMIT 1`).bind(JSON.stringify(dates)).first();
  if (remaining) return { operation:SCHEDULE_REPAIR_OPERATION,repaired:record.fixture_id,partial:true };
  await database.prepare(`DELETE FROM fixture_schedule_refresh_pending
    WHERE fixture_id = ? AND old_date_jst = ? AND new_date_jst = ? AND repair_token = ?`)
    .bind(record.fixture_id, record.old_date_jst, record.new_date_jst, record.repair_token).run();
  return { operation: SCHEDULE_REPAIR_OPERATION, repaired: record.fixture_id };
}

export async function updateFixtureSchedule(env, request) {
  const input = assertScheduleRequest(request);
  const database = env.FOOTBALL_DB;
  if (await pending(database)) throw new Error('Repair the pending schedule index before the next update.');
  const existing = await database.prepare(`SELECT fixture.kickoff_utc, fixture.date_jst,
      fixture.status_short, fixture.published_revision, competition.canonical_id AS competition_id,
      season.canonical_id AS season_id
    FROM fixtures fixture
    JOIN competition_seasons season ON season.id = fixture.competition_season_id
    JOIN competitions competition ON competition.id = season.competition_id
    WHERE fixture.canonical_id = ?`).bind(input.fixtureId).first();
  if (!existing || existing.competition_id !== input.competitionId
    || existing.season_id !== input.seasonId || existing.published_revision !== null
    || existing.kickoff_utc !== input.oldKickoffUtc || existing.status_short !== input.oldStatus
    || existing.date_jst !== dateJst(input.oldKickoffUtc)) {
    throw new Error('Schedule update is stale or would replace a published fixture.');
  }
  const newDate = dateJst(input.newKickoffUtc);
  const now = new Date().toISOString();
  const repairToken = crypto.randomUUID();
  // Reserve the single repair slot inside the same transaction as the conditional update.
  // A stale read or an occupied slot changes neither the fixture nor the repair table.
  const statements = [
    database.prepare(`INSERT INTO fixture_schedule_refresh_pending
      (fixture_id, old_date_jst, new_date_jst, changed_at, repair_token)
      SELECT fixture.canonical_id, fixture.date_jst, ?, ?, ? FROM fixtures fixture
      JOIN competition_seasons season ON season.id = fixture.competition_season_id
      JOIN competitions competition ON competition.id = season.competition_id
      WHERE fixture.canonical_id = ? AND fixture.kickoff_utc = ?
        AND fixture.status_short = ? AND fixture.published_revision IS NULL
        AND fixture.date_jst = ? AND competition.canonical_id = ? AND season.canonical_id = ?
        AND NOT EXISTS (SELECT 1 FROM fixture_schedule_refresh_pending)`)
      .bind(newDate, now, repairToken, input.fixtureId, input.oldKickoffUtc, input.oldStatus,
        existing.date_jst, input.competitionId, input.seasonId),
    database.prepare(`UPDATE fixtures SET kickoff_utc = ?, date_jst = ?, status_short = ?,
      status_long = ?, status_elapsed = NULL, ingestion_state = 'scheduled'
      WHERE canonical_id = ? AND kickoff_utc = ? AND status_short = ? AND published_revision IS NULL
        AND EXISTS (SELECT 1 FROM fixture_schedule_refresh_pending
          WHERE fixture_id = ? AND old_date_jst = ? AND new_date_jst = ? AND repair_token = ?)`)
      .bind(new Date(input.newKickoffUtc).toISOString(), newDate, input.newStatus,
        STATUS_LABELS[input.newStatus], input.fixtureId, input.oldKickoffUtc, input.oldStatus,
        input.fixtureId, existing.date_jst, newDate, repairToken),
  ];
  const results = await database.batch(statements);
  if (results.length !== 2 || results.some(result => result.success === false)) {
    throw new Error('Schedule update is stale or the pending repair slot is occupied.');
  }
  const committed = await database.prepare(`SELECT fixture.canonical_id FROM fixtures fixture
    JOIN fixture_schedule_refresh_pending repair ON repair.fixture_id=fixture.canonical_id
    WHERE fixture.canonical_id=? AND fixture.kickoff_utc=? AND fixture.date_jst=?
      AND fixture.status_short=? AND repair.repair_token=?`)
    .bind(input.fixtureId,new Date(input.newKickoffUtc).toISOString(),newDate,input.newStatus,repairToken).first();
  if (!committed) throw new Error('Schedule update is stale or the pending repair slot is occupied.');
  return { operation: SCHEDULE_UPDATE_OPERATION, fixtureId: input.fixtureId,
    oldDate: existing.date_jst, newDate };
}
