import { refreshDateIndexesFromD1 } from './date-index-refresh.mjs';

export const SCHEDULE_UPDATE_OPERATION = 'fixture_schedule_update';
export const SCHEDULE_REPAIR_OPERATION = 'fixture_schedule_repair';
const VERSION = 'jfw-d1-admin-ingest/1';
const NON_FINAL = new Set(['NS', 'TBD', 'PST']);

function utc(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
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
  const result = await database.prepare(`SELECT fixture_id, old_date_jst, new_date_jst
    FROM fixture_schedule_refresh_pending ORDER BY changed_at, fixture_id LIMIT 1`).first();
  return result || null;
}

export async function repairFixtureSchedule(env) {
  const database = env.FOOTBALL_DB;
  const record = await pending(database);
  if (!record) return { operation: SCHEDULE_REPAIR_OPERATION, repaired: null };
  const row = await database.prepare(`SELECT fixture.date_jst, fixture.published_revision
    FROM fixtures fixture WHERE fixture.canonical_id = ?`).bind(record.fixture_id).first();
  if (!row || row.date_jst !== record.new_date_jst || row.published_revision !== null) {
    throw new Error('Pending schedule repair differs from the stored unpublished fixture.');
  }
  const base = { schemaVersion: VERSION, operation: 'date_index_refresh' };
  if (record.old_date_jst !== record.new_date_jst) {
    await refreshDateIndexesFromD1(env, { ...base, date: record.old_date_jst,
      fixtureIds: [], scheduledDepartures: [{ fixtureId: record.fixture_id, date: record.new_date_jst }] });
  }
  await refreshDateIndexesFromD1(env, { ...base, date: record.new_date_jst,
    fixtureIds: [record.fixture_id] });
  await database.prepare(`DELETE FROM fixture_schedule_refresh_pending
    WHERE fixture_id = ? AND old_date_jst = ? AND new_date_jst = ?`)
    .bind(record.fixture_id, record.old_date_jst, record.new_date_jst).run();
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
  const statements = [
    database.prepare(`UPDATE fixtures SET kickoff_utc = ?, date_jst = ?, status_short = ?,
      status_long = ?, status_elapsed = NULL, ingestion_state = 'scheduled'
      WHERE canonical_id = ? AND kickoff_utc = ? AND status_short = ? AND published_revision IS NULL`)
      .bind(input.newKickoffUtc, newDate, input.newStatus,
        input.newStatus === 'PST' ? 'Postponed' : input.newStatus === 'TBD' ? 'Time to be defined' : 'Not Started',
        input.fixtureId, input.oldKickoffUtc, input.oldStatus),
    database.prepare(`INSERT INTO fixture_schedule_refresh_pending
      (fixture_id, old_date_jst, new_date_jst, changed_at) VALUES (?, ?, ?, ?)`)
      .bind(input.fixtureId, existing.date_jst, newDate, now),
  ];
  await database.batch(statements);
  return { operation: SCHEDULE_UPDATE_OPERATION, fixtureId: input.fixtureId,
    oldDate: existing.date_jst, newDate };
}
