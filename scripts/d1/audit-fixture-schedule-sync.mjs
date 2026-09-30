import fs from 'node:fs';
import { createHash } from 'node:crypto';

function rows(path) {
  const payload = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.success === false
    || !Array.isArray(payload[0]?.results)) throw new Error(`D1 audit query failed: ${path}`);
  return payload[0].results;
}

function jst(utc) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(utc));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function digest(ids) {
  return createHash('sha256').update(`${ids.sort().join('\n')}\n`).digest('hex');
}

function verify() {
  const [expectedFile, inventoryFile, genericFile, competitionFile, pendingFile] = process.argv.slice(2);
  if (![expectedFile, inventoryFile, genericFile, competitionFile, pendingFile].every(Boolean)) {
    throw new Error('Use EXPECTED INVENTORY GENERIC COMPETITION PENDING.');
  }
  const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
  if (expected.schemaVersion !== 'jfw-reviewed-schedule-preview/1'
    || expected.sourceRunId !== 36652836058 || expected.changes?.length !== 217
    || expected.held?.length !== 1) throw new Error('Reviewed preview identity is invalid.');
  const fixtures = rows(inventoryFile);
  if (fixtures.length !== 3420 || new Set(fixtures.map(item => item.fixture_id)).size !== 3420) {
    throw new Error('D1 fixture audit inventory is incomplete.');
  }
  const byId = new Map(fixtures.map(item => [item.fixture_id, item]));
  const dates = new Set();
  const scopes = new Set();
  for (const change of expected.changes) {
    const actual = byId.get(change.fixtureId);
    if (!actual || actual.kickoff_utc !== change.newKickoffUtc
      || actual.status_short !== change.newStatus || actual.published_revision !== null
      || actual.competition_id !== change.competitionId || actual.season_id !== change.seasonId
      || actual.date_jst !== jst(change.newKickoffUtc)) {
      throw new Error(`D1 differs from the independently saved preview: ${change.fixtureId}.`);
    }
    for (const date of [jst(change.oldKickoffUtc), jst(change.newKickoffUtc)]) {
      dates.add(date);
      scopes.add(`${change.competitionId}/${date}`);
    }
  }
  if (byId.get(expected.held[0].fixtureId)?.published_revision == null) {
    throw new Error('Published detail hold was overwritten.');
  }
  if (rows(pendingFile).length !== 0) throw new Error('Date index repair remains pending.');
  const generic = new Map(rows(genericFile).map(item => [item.date_jst, item]));
  const competition = new Map(rows(competitionFile).map(item => [
    `${item.competition_id}/${item.date_jst}`, item,
  ]));
  for (const date of dates) {
    const ids = fixtures.filter(item => item.date_jst === date).map(item => item.fixture_id);
    const coverage = generic.get(date);
    if (!coverage || coverage.fixture_count !== ids.length
      || coverage.fixture_id_digest !== digest(ids)) {
      throw new Error(`Generic date coverage is incomplete: ${date}.`);
    }
  }
  for (const scope of scopes) {
    const [competitionId, date] = scope.split('/');
    const ids = fixtures.filter(item => item.date_jst === date && item.competition_id === competitionId)
      .map(item => item.fixture_id);
    const coverage = competition.get(scope);
    if (!coverage || coverage.fixture_count !== ids.length
      || coverage.fixture_id_digest !== digest(ids)) {
      throw new Error(`Competition date coverage is incomplete: ${scope}.`);
    }
  }
  return { fixtureCount: fixtures.length, verifiedChanges: expected.changes.length,
    heldPublishedDetails: expected.held.length, verifiedDates: dates.size,
    verifiedCompetitionDates: scopes.size, pendingRepairs: 0 };
}

try { console.log(JSON.stringify(verify(), null, 2)); }
catch (error) { console.error(error); process.exitCode = 1; }
