import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createClientFromEnv } = require('../api-football/client.js');
const TARGETS = [39, 40, 61, 78, 88, 94, 135, 140, 144, 179];
const validId = value => Number.isSafeInteger(value) && value > 0;

export function normalizeRoster(pages, squads, profiles = []) {
  const players = new Map();
  function add(profile, team, source) {
    if (!validId(profile?.id) || !profile.name || !validId(team?.id) || !team.name) return;
    const existing = players.get(profile.id) || { id: profile.id, name: profile.name, nationality: null,
      birthDate: null, photo: null, teams: [] };
    if (existing.nationality && profile.nationality && existing.nationality !== profile.nationality) {
      throw new Error(`Conflicting nationality for player ${profile.id}.`);
    }
    if (existing.birthDate && profile.birth?.date && existing.birthDate !== profile.birth.date) {
      throw new Error(`Conflicting birth date for player ${profile.id}.`);
    }
    if (source === 'season_players') {
      existing.name = profile.name;
      existing.nationality = profile.nationality || existing.nationality;
      existing.birthDate = profile.birth?.date || existing.birthDate;
      existing.photo = profile.photo || existing.photo;
    }
    if (!existing.teams.some(row => row.id === team.id && row.source === source)) {
      existing.teams.push({ id: team.id, name: team.name, logo: team.logo || null, source });
    }
    players.set(profile.id, existing);
  }
  for (const row of pages) {
    for (const stat of row.statistics || []) {
      if (TARGETS.includes(stat.league?.id)) add(row.player, stat.team, 'season_players');
    }
  }
  for (const row of squads) for (const player of row.players || []) add(player, row.team, 'team_squad');
  for (const row of profiles) {
    const existing = players.get(row.player?.id);
    if (!existing) continue;
    const profile = row.player;
    if (existing.nationality && profile.nationality && existing.nationality !== profile.nationality) {
      throw new Error(`Conflicting nationality for player ${profile.id}.`);
    }
    existing.name = profile.name || existing.name;
    existing.nationality = profile.nationality || existing.nationality;
    existing.birthDate = profile.birth?.date || existing.birthDate;
    existing.photo = profile.photo || existing.photo;
  }
  return [...players.values()].sort((a, b) => a.id - b.id);
}

export async function collectRoster(client) {
  const pages = [], squads = [];
  const allTeams = new Map();
  for (const league of TARGETS) {
    const teams = (await client.get('teams', { league, season: 2026 })).data.response || [];
    if (teams.length < 10) throw new Error(`Incomplete team inventory for league ${league}.`);
    for (const row of teams) allTeams.set(row.team.id, row.team);
    let page = 1, total = 1;
    do {
      const payload = (await client.get('players', { league, season: 2026, page })).data;
      const count = Number(payload.paging?.total);
      if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error(`Invalid player paging for league ${league}.`);
      total = count;
      pages.push(...payload.response);
      page += 1;
    } while (page <= total);
  }
  for (const team of allTeams.values()) {
    const rows = (await client.get('players/squads', { team: team.id })).data.response;
    if (!Array.isArray(rows) || !rows.length) throw new Error(`Missing squad for team ${team.id}.`);
    for (const row of rows) squads.push({ team: row.team, players: row.players });
  }
  const pageIds = new Set(pages.map(row => row.player?.id));
  const missing = [...new Set(squads.flatMap(row => row.players || []).map(row => row.id))]
    .filter(id => validId(id) && !pageIds.has(id));
  if (missing.length > 1500) throw new Error('Roster-only identity request budget exceeded.');
  const profiles = [];
  for (const id of missing) {
    let result = (await client.get('players', { id, season: 2026 })).data.response || [];
    if (!result.length) result = (await client.get('players', { id, season: 2025 })).data.response || [];
    profiles.push(...result.filter(row => row.player?.id === id));
  }
  return { pages, squads, profiles, teamCount: allTeams.size };
}

export async function publishRoster(players, runId, fetchImpl = fetch, env = process.env) {
  const observedOn = runId.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(runId)
    || !/^https:\/\//.test(env.ADMIN_INGEST_URL || '')
    || !env.ADMIN_INGEST_TOKEN) throw new Error('Roster publication configuration is missing.');
  let published = 0;
  for (let i = 0; i < players.length; i += 40) {
    const batch = players.slice(i, i + 40);
    const response = await fetchImpl(env.ADMIN_INGEST_URL, { method: 'POST',
      headers: { authorization: `Bearer ${env.ADMIN_INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'player_roster_upsert',
        observedOn, runId, players: batch }),
      signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    if (!response.ok || result.ok !== true || result.report?.players !== batch.length) {
      throw new Error(`Roster batch ${i / 40 + 1} was rejected: ${response.status} ${result.detail || result.error || ''}`);
    }
    published += batch.length;
  }
  const completion = await fetchImpl(env.ADMIN_INGEST_URL, { method: 'POST',
    headers: { authorization: `Bearer ${env.ADMIN_INGEST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'player_roster_complete',
      observedOn, runId, expectedPlayers: players.length }), signal: AbortSignal.timeout(30000) });
  const final = await completion.json();
  if (!completion.ok || final.ok !== true || final.report?.completed !== true) {
    throw new Error(`Roster completion rejected: ${completion.status} ${final.detail || final.error || ''}`);
  }
  return published;
}

async function main() {
  const snapshotIndex = process.argv.indexOf('--snapshot');
  const execute = process.argv.includes('--execute');
  let records, runId;
  if (snapshotIndex >= 0) {
    const file = process.argv[snapshotIndex + 1];
    if (!file) throw new Error('--snapshot needs a file.');
    const archive = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (archive.snapshotId !== '20260908-021509068Z') throw new Error('Unexpected pinned snapshot.');
    records = { pages: archive.players, squads: archive.squads, profiles: [], teamCount: archive.squads.length };
    runId = '2026-09-08T02:15:09.068Z';
  } else {
    const client = createClientFromEnv(process.env, { minimumIntervalMs: 350, dailyReserve: 500 });
    await client.refreshDailyQuota();
    records = await collectRoster(client);
    runId = new Date().toISOString();
  }
  const players = normalizeRoster(records.pages, records.squads, records.profiles);
  if (players.length < 4000 || records.teamCount < 170) throw new Error('Incomplete roster inventory.');
  const report = { runId, playerCount: players.length, teams: records.teamCount,
    nationalityKnown: players.filter(player => player.nationality).length,
    japan: players.filter(player => player.nationality === 'Japan').length };
  console.log(JSON.stringify(report));
  if (execute) console.log(JSON.stringify({ published: await publishRoster(players, runId) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
