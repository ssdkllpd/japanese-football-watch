export const PLAYER_ROSTER_OPERATION = 'player_roster_upsert';
export const PLAYER_ROSTER_COMPLETE_OPERATION = 'player_roster_complete';

const id = value => Number.isSafeInteger(value) && value > 0;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const string = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const runId = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

export function assertPlayerRosterRequest(input) {
  if (!input || ![PLAYER_ROSTER_OPERATION, PLAYER_ROSTER_COMPLETE_OPERATION].includes(input.operation)
    || !date(input.observedOn) || !runId(input.runId) || input.runId.slice(0, 10) !== input.observedOn
    || Object.keys(input).some(key => !['schemaVersion', 'operation', 'observedOn', 'runId', 'players', 'expectedPlayers', 'expectedObservations', 'squadTeamIds'].includes(key))) {
    throw new Error('Invalid player roster request.');
  }
  if (input.operation === PLAYER_ROSTER_COMPLETE_OPERATION) {
    if (!Number.isSafeInteger(input.expectedPlayers) || input.expectedPlayers < 4000
      || input.expectedPlayers > 10000 || !id(input.expectedObservations)
      || !Array.isArray(input.squadTeamIds) || !input.squadTeamIds.length || input.squadTeamIds.length > 250
      || input.squadTeamIds.some(value => !id(value))
      || new Set(input.squadTeamIds).size !== input.squadTeamIds.length
      || input.players !== undefined) throw new Error('Invalid roster completion count.');
    return input;
  }
  if (!Array.isArray(input.players) || input.players.length < 1 || input.players.length > 40
    || input.expectedPlayers !== undefined) {
    throw new Error('Invalid player roster batch.');
  }
  const seen = new Set();
  for (const item of input.players) {
    if (!item || !id(item.id) || !string(item.name)
      || item.nationality != null && !string(item.nationality)
      || item.position != null && !string(item.position)
      || item.birthDate != null && !date(item.birthDate)
      || item.photo != null && (typeof item.photo !== 'string' || !/^https:\/\//.test(item.photo) || item.photo.length > 500)
      || !Array.isArray(item.teams) || item.teams.length < 1 || item.teams.length > 10
      || Object.keys(item).some(key => !['id', 'name', 'nationality', 'birthDate', 'photo', 'position', 'teams'].includes(key))) {
      throw new Error('Invalid player roster identity.');
    }
    if (seen.has(item.id)) throw new Error('Duplicate player ID in roster batch.');
    seen.add(item.id);
    const teamIds = new Set();
    for (const team of item.teams) {
      if (!team || !id(team.id) || !string(team.name)
        || team.logo != null && (typeof team.logo !== 'string' || !/^https:\/\//.test(team.logo) || team.logo.length > 500)
        || !['season_players', 'team_squad'].includes(team.source)
        || Object.keys(team).some(key => !['id', 'name', 'logo', 'source'].includes(key))) {
        throw new Error('Invalid player roster team.');
      }
      const key = `${team.id}:${team.source}`;
      if (teamIds.has(key)) throw new Error('Duplicate player/team observation.');
      teamIds.add(key);
    }
  }
  return input;
}

export async function publishPlayerRoster(env, input) {
  if (!env.FOOTBALL_DB) throw new Error('D1 binding is unavailable.');
  const source = await env.FOOTBALL_DB.prepare("SELECT id FROM provider_sources WHERE code = 'api-football'").first();
  if (!source) throw new Error('API-Football provider source is missing.');
  const prior = await env.FOOTBALL_DB.prepare('SELECT observed_on,completed_at FROM player_roster_sync_runs WHERE run_id=?')
    .bind(input.runId).first();
  if (prior?.completed_at || prior && prior.observed_on !== input.observedOn) {
    throw new Error('Roster run is completed or has a different observation date.');
  }
  const statements = [env.FOOTBALL_DB.prepare(`INSERT OR IGNORE INTO player_roster_sync_runs(run_id,observed_on)
    VALUES (?,?)`).bind(input.runId, input.observedOn)];
  const seenTeams = new Map();
  for (const player of input.players) for (const team of player.teams) {
    if (!seenTeams.has(team.id) || team.source === 'team_squad') seenTeams.set(team.id, team);
  }
  for (const team of seenTeams.values()) {
    statements.push(env.FOOTBALL_DB.prepare(`INSERT INTO teams(canonical_id,source_id,provider_id,name,logo_url)
      VALUES (?,?,?,?,?) ON CONFLICT(canonical_id) DO UPDATE SET
      name=excluded.name,logo_url=COALESCE(excluded.logo_url,teams.logo_url)`)
      .bind(`af:team:${team.id}`, source.id, team.id, team.name, team.logo ?? null));
  }
  for (const player of input.players) {
    statements.push(env.FOOTBALL_DB.prepare(`INSERT INTO players(canonical_id,source_id,provider_id,display_name,nationality,birth_date,photo_url,position,roster_profile_updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(canonical_id) DO UPDATE SET
      display_name=excluded.display_name,
      nationality=COALESCE(excluded.nationality,players.nationality),
      birth_date=COALESCE(excluded.birth_date,players.birth_date),
      photo_url=COALESCE(excluded.photo_url,players.photo_url),
      position=COALESCE(excluded.position,players.position),
      roster_profile_updated_at=excluded.roster_profile_updated_at
      WHERE players.roster_profile_updated_at IS NULL OR players.roster_profile_updated_at <= excluded.roster_profile_updated_at`)
      .bind(`af:player:${player.id}`, source.id, player.id, player.name, player.nationality ?? null,
        player.birthDate ?? null, player.photo ?? null, player.position ?? null, input.runId));
    for (const team of player.teams) {
      statements.push(env.FOOTBALL_DB.prepare(`INSERT OR IGNORE INTO player_roster_observations(run_id,player_id,team_id,observed_on,source)
        VALUES (?,(SELECT id FROM players WHERE canonical_id=?),(SELECT id FROM teams WHERE canonical_id=?),?,?)`)
        .bind(input.runId, `af:player:${player.id}`, `af:team:${team.id}`, input.observedOn, team.source));
    }
  }
  await env.FOOTBALL_DB.batch(statements);
  return { schemaVersion: 'jfw-d1-admin-ingest-report/1', operation: PLAYER_ROSTER_OPERATION,
    observedOn: input.observedOn, runId: input.runId,
    players: input.players.length, observations: input.players.reduce((n, p) => n + p.teams.length, 0) };
}

export async function completePlayerRoster(env, input) {
  if (!env.FOOTBALL_DB) throw new Error('D1 binding is unavailable.');
  const row = await env.FOOTBALL_DB.prepare(`SELECT run.observed_on,run.completed_at,
    (SELECT COUNT(DISTINCT player_id) FROM player_roster_observations WHERE run_id=run.run_id) AS actual,
    (SELECT COUNT(*) FROM player_roster_observations WHERE run_id=run.run_id) AS observations
    FROM player_roster_sync_runs run WHERE run.run_id=?`).bind(input.runId).first();
  const teams = await env.FOOTBALL_DB.prepare(`SELECT DISTINCT team.provider_id AS id
    FROM player_roster_observations observation JOIN teams team ON team.id=observation.team_id
    WHERE observation.run_id=? AND observation.source='team_squad' ORDER BY team.provider_id`).bind(input.runId).all();
  if (!row || row.observations !== input.expectedObservations
    || JSON.stringify(teams.results.map(team => team.id)) !== JSON.stringify([...input.squadTeamIds].sort((a,b)=>a-b))
    || row.observed_on !== input.observedOn || row.actual !== input.expectedPlayers) {
    throw new Error('Roster completion count or identity differs from the published batches.');
  }
  if (!row.completed_at) await env.FOOTBALL_DB.prepare(`UPDATE player_roster_sync_runs
    SET completed_at=?, player_count=? WHERE run_id=? AND completed_at IS NULL`)
    .bind(new Date().toISOString(), input.expectedPlayers, input.runId).run();
  return { schemaVersion: 'jfw-d1-admin-ingest-report/1', operation: PLAYER_ROSTER_COMPLETE_OPERATION,
    runId: input.runId, players: input.expectedPlayers, completed: true };
}
