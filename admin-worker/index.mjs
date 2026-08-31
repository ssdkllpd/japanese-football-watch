import {
  assertValidStandingsPayload,
  standingsIdentityDigestInput,
} from '../shared/standings-contract.mjs';
import {
  FIXTURE_OPERATION,
  assertFixtureRequest,
  publishFixtureFromR2,
} from './fixture-ingest.mjs';

const REQUEST_SCHEMA = 'jfw-d1-admin-ingest/1';
const STANDINGS_OPERATION = 'standings_publish';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function expectedStandingsKey(competitionId, seasonId) {
  return `football/v2/competitions/${competitionId}/seasons/${seasonId}/standings/latest.json`;
}

async function tokenDigest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function requireAdminToken(request, env) {
  const token = env.ADMIN_INGEST_TOKEN;
  if (typeof token !== 'string' || !token) {
    const error = new Error('Admin ingest is not configured.');
    error.status = 503;
    throw error;
  }
  const [provided, expected] = await Promise.all([
    tokenDigest(request.headers.get('authorization') || ''),
    tokenDigest(`Bearer ${token}`),
  ]);
  let difference = provided.length ^ expected.length;
  for (let index = 0; index < Math.max(provided.length, expected.length); index += 1) {
    difference |= (provided[index] || 0) ^ (expected[index] || 0);
  }
  if (difference !== 0) {
    const error = new Error('Unauthorized admin ingest request.');
    error.status = 401;
    throw error;
  }
}

function assertRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Admin ingest request must be an object.');
  if (value.schemaVersion !== REQUEST_SCHEMA) throw new Error(`schemaVersion must be ${REQUEST_SCHEMA}.`);
  if (value.operation === FIXTURE_OPERATION) return assertFixtureRequest(value);
  const allowed = new Set(['schemaVersion', 'operation', 'competitionId', 'seasonId']);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Admin ingest request contains unknown fields: ${unknown.join(', ')}.`);
  if (value.operation !== STANDINGS_OPERATION
    || !/^af:competition:\d+$/.test(String(value.competitionId || ''))
    || !/^af:season:\d+:\d+$/.test(String(value.seasonId || ''))) {
    throw new Error('Admin ingest request is invalid.');
  }
  return value;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function statement(database, sql, params = []) {
  return database.prepare(sql).bind(...params);
}

async function first(database, sql, params = []) {
  return database.prepare(sql).bind(...params).first();
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function valueList(rows, width) {
  return rows.map(() => `(${Array.from({ length: width }, () => '?').join(', ')})`).join(', ');
}

function scopes(scope) {
  return [scope.played, scope.wins, scope.draws, scope.losses, scope.goalsFor, scope.goalsAgainst];
}

async function resolveSeason(database, competitionId, seasonId) {
  return first(database, `
    SELECT season.id, season.provider_season, competition.source_id,
      competition.id AS competition_internal_id, competition.provider_id AS competition_provider_id
    FROM competition_seasons season
    JOIN competitions competition ON competition.id = season.competition_id
    WHERE competition.canonical_id = ? AND season.canonical_id = ?
  `, [competitionId, seasonId]);
}

async function assertStoredTeamIdentities(database, sourceId, teams) {
  if (!teams.length) return;
  for (const group of chunks(teams, 25)) {
    const placeholders = group.map(() => '?').join(', ');
    const result = await database.prepare(`
      SELECT canonical_id, source_id, provider_id FROM teams WHERE canonical_id IN (${placeholders})
    `).bind(...group.map(team => team.id)).all();
    for (const row of result.results || []) {
      const team = teams.find(value => value.id === row.canonical_id);
      if (!team || row.source_id !== sourceId || row.provider_id !== team.providerId) {
        throw new Error(`Stored team provider identity differs: ${row.canonical_id}`);
      }
    }
  }
}

function writeStatements(database, season, payload, sourceKey, sourceSha256, identityDigest) {
  const snapshotWhere = 'competition_season_id = ? AND observed_at = ?';
  const snapshotParams = [season.id, payload.generatedAt];
  const statements = [
    statement(database, `UPDATE competitions SET name = ?, country_name = ?, logo_url = ?, flag_url = ? WHERE id = ?`, [
      payload.competition.name, payload.competition.country, payload.competition.logo,
      payload.competition.flag, season.competition_internal_id,
    ]),
    statement(database, 'UPDATE competition_seasons SET label = ? WHERE id = ?', [
      payload.season.label ?? String(payload.season.providerSeason), season.id,
    ]),
    statement(database, `
      INSERT INTO standings_snapshots(
        competition_season_id, observed_at, is_final, checksum, contract_version, section_presence,
        provenance_source, provenance_fetched_at, provenance_verification, provenance_issues_json
      ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(competition_season_id, observed_at) DO UPDATE SET
        checksum = excluded.checksum, contract_version = excluded.contract_version,
        section_presence = excluded.section_presence, provenance_source = excluded.provenance_source,
        provenance_fetched_at = excluded.provenance_fetched_at,
        provenance_verification = excluded.provenance_verification,
        provenance_issues_json = excluded.provenance_issues_json
    `, [
      season.id, payload.generatedAt, sourceSha256, payload.contractVersion,
      payload.sectionStates.standings.presence, payload.provenance.source,
      payload.provenance.fetchedAt, payload.provenance.verification,
      JSON.stringify(payload.provenance.issues),
    ]),
    statement(database, `DELETE FROM standings_publications WHERE snapshot_id = (
      SELECT id FROM standings_snapshots WHERE ${snapshotWhere}
    )`, snapshotParams),
    statement(database, `DELETE FROM standings_rows WHERE snapshot_id = (
      SELECT id FROM standings_snapshots WHERE ${snapshotWhere}
    )`, snapshotParams),
    statement(database, `DELETE FROM standings_groups WHERE snapshot_id = (
      SELECT id FROM standings_snapshots WHERE ${snapshotWhere}
    )`, snapshotParams),
  ];
  const teams = payload.groups.flatMap(group => group.table.map(row => row.team));
  for (const group of chunks(teams, 20)) {
    statements.push(statement(database, `
      INSERT INTO teams(canonical_id, source_id, provider_id, name, logo_url)
      VALUES ${valueList(group, 5)}
      ON CONFLICT(canonical_id) DO UPDATE SET name = excluded.name, logo_url = excluded.logo_url
    `, group.flatMap(team => [team.id, season.source_id, team.providerId, team.name, team.logo])));
  }
  if (teams.length) {
    statements.push(statement(database, `
      INSERT OR IGNORE INTO competition_season_teams(competition_season_id, team_id)
      VALUES ${teams.map(() => '(?, (SELECT id FROM teams WHERE canonical_id = ?))').join(', ')}
    `, teams.flatMap(team => [season.id, team.id])));
  }
  const groups = payload.groups.map((group, groupOrder) => ({ ...group, groupOrder }));
  for (const group of chunks(groups, 20)) {
    statements.push(statement(database, `
      INSERT INTO standings_groups(snapshot_id, group_id, group_name, group_order)
      VALUES ${group.map(() => '((SELECT id FROM standings_snapshots WHERE competition_season_id = ? AND observed_at = ?), ?, ?, ?)').join(', ')}
    `, group.flatMap(value => [...snapshotParams, value.id, value.name, value.groupOrder])));
  }
  const rows = groups.flatMap(group => group.table.map((row, rowOrder) => ({ row, group, rowOrder })));
  for (const group of chunks(rows, 2)) {
    const rowValues = `(
      (SELECT id FROM standings_snapshots WHERE competition_season_id = ? AND observed_at = ?),
      (SELECT id FROM teams WHERE canonical_id = ?),
      ${Array.from({ length: 33 }, () => '?').join(', ')}
    )`;
    statements.push(statement(database, `
      INSERT INTO standings_rows(
        snapshot_id, team_id, group_name, rank, points, played, goal_difference, form,
        group_id, group_order, row_order, wins, draws, losses, goals_for, goals_against,
        home_played, home_wins, home_draws, home_losses, home_goals_for, home_goals_against,
        away_played, away_wins, away_draws, away_losses, away_goals_for, away_goals_against,
        status, description, updated_at, provenance_source, provenance_fetched_at,
        provenance_verification, provenance_issues_json
      ) VALUES ${group.map(() => rowValues).join(', ')}
    `, group.flatMap(({ row, group: standingsGroup, rowOrder }) => [
      ...snapshotParams, row.team.id, standingsGroup.name, row.rank, row.points,
      row.overall.played, row.goalDifference, row.form, standingsGroup.id, standingsGroup.groupOrder,
      rowOrder, row.overall.wins, row.overall.draws, row.overall.losses,
      row.overall.goalsFor, row.overall.goalsAgainst, ...scopes(row.home), ...scopes(row.away),
      row.status, row.description, row.updatedAt, row.provenance.source, row.provenance.fetchedAt,
      row.provenance.verification, JSON.stringify(row.provenance.issues),
    ])));
  }
  statements.push(statement(database, `
    INSERT INTO standings_publications(
      competition_season_id, snapshot_id, row_count, identity_digest, generated_at, source_r2_key, source_sha256
    ) VALUES (?, (SELECT id FROM standings_snapshots WHERE ${snapshotWhere}), ?, ?, ?, ?, ?)
    ON CONFLICT(competition_season_id) DO UPDATE SET
      snapshot_id = excluded.snapshot_id, row_count = excluded.row_count,
      identity_digest = excluded.identity_digest, generated_at = excluded.generated_at,
      source_r2_key = excluded.source_r2_key, source_sha256 = excluded.source_sha256
  `, [
    season.id, ...snapshotParams, rows.length, identityDigest, payload.generatedAt, sourceKey, sourceSha256,
  ]));
  return { statements, rowCount: rows.length };
}

export async function publishStandingsFromR2(env, competitionId, seasonId) {
  if (!env.FOOTBALL_DB || !env.FOOTBALL_DATA) throw new Error('Admin ingest bindings are unavailable.');
  const sourceR2Key = expectedStandingsKey(competitionId, seasonId);
  const object = await env.FOOTBALL_DATA.get(sourceR2Key);
  if (!object) {
    const error = new Error('Standings R2 object is missing.');
    error.status = 404;
    throw error;
  }
  const raw = await object.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('Standings R2 object is not JSON.'); }
  assertValidStandingsPayload(payload, { expectedCompetitionId: competitionId, expectedSeasonId: seasonId });
  const season = await resolveSeason(env.FOOTBALL_DB, competitionId, seasonId);
  if (!season || season.provider_season !== payload.season.providerSeason
    || season.competition_provider_id !== payload.competition.providerId) {
    throw new Error('Competition-season is not stored with the declared provider identity.');
  }
  const teams = payload.groups.flatMap(group => group.table.map(row => row.team));
  await assertStoredTeamIdentities(env.FOOTBALL_DB, season.source_id, teams);
  const sourceSha256 = await sha256(raw);
  const identityDigest = await sha256(standingsIdentityDigestInput(payload.groups));
  const write = writeStatements(env.FOOTBALL_DB, season, payload, sourceR2Key, sourceSha256, identityDigest);
  await env.FOOTBALL_DB.batch(write.statements);
  return {
    schemaVersion: 'jfw-d1-admin-ingest-report/1', operation: STANDINGS_OPERATION,
    competitionId, seasonId, sourceR2Key, sourceSha256, rowCount: write.rowCount,
    identityDigest, publishedAt: payload.generatedAt,
  };
}

export async function handleAdminIngest(request, env) {
  try {
    if (new URL(request.url).pathname !== '/admin/v1/ingest') return json({ error: 'Not found' }, 404);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    await requireAdminToken(request, env);
    const input = assertRequest(await request.json());
    const report = input.operation === FIXTURE_OPERATION
      ? await publishFixtureFromR2(env, input)
      : await publishStandingsFromR2(env, input.competitionId, input.seasonId);
    return json({ ok: true, report }, 200);
  } catch (error) {
    const status = error?.status || 422;
    return json({ error: status === 401 ? 'Unauthorized' : 'Admin ingest rejected' }, status);
  }
}

export default { fetch: handleAdminIngest };
