const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRuntimeContext } = require('../scripts/shared/runtime-data-loader');

const ROOT = path.join(__dirname, '..');

test('all-competitions totals include official cups and exclude friendly fixtures', async () => {
  const season = '2026-27';
  const player = {
    playerId: 'jp-official-test',
    name: '公式戦太郎',
    club: 'Club A',
    league: 'プレミアリーグ',
    stats: { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 },
  };
  const context = createRuntimeContext(ROOT, season, {
    updated: '2026-08-10 10:00 JST',
    players: [player],
    matches: [],
    topMatches: [],
    playerMatchStats: [],
    gaResults: [],
  }, { current: season, seasons: [{ id: season, data: 'data.json' }] });
  context.console = { log() {}, warn() {}, error() {} };
  context.fetch = async url => {
    const clean = String(url).replace(/[?&]v=\d+$/, '');
    if (clean === 'config/player-registry.json') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ players: [{ playerId: player.playerId, name: player.name, aliases: [], providerIds: {} }] }),
      };
    }
    if (clean.includes('index.json')) return { ok: true, status: 200, json: async () => ({ fragments: ['scope.json'] }) };
    if (clean.includes('scope.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          updated: '2026-08-20 12:00 JST',
          matchUpdates: [
            { matchId: 'ucl-1', league: 'UEFA Champions League', ko: '2026-08-18 20:00', match: 'Club A 1-0 X', addIfMissing: true },
            { matchId: 'friendly-1', league: 'Club Friendly', ko: '2026-08-19 20:00', match: 'Club A 2-0 Y', addIfMissing: true },
          ],
          playerMatchStats: [
            {
              recordId: 'ucl-1-p', matchId: 'ucl-1', playerId: player.playerId, player: player.name,
              club: 'Club A', competition: 'UEFA Champions League', appearance: true, start: false,
              values: { minutes: 25, goals: 0, assists: 0 }, missingFields: [],
            },
            {
              recordId: 'friendly-1-p', matchId: 'friendly-1', playerId: player.playerId, player: player.name,
              club: 'Club A', competition: 'Club Friendly', appearance: true, start: true,
              values: { minutes: 90, goals: 2, assists: 1 }, missingFields: [],
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backfill-loader.js'), 'utf8'), context, { filename: 'backfill-loader.js' });
  await context.window.JFWBackfill.boot();

  const result = context.D.players[0];
  assert.equal(result.seasonStats.apps, 1);
  assert.equal(result.seasonStats.minutes, 25);
  assert.equal(result.seasonStats.goals, 0);
  assert.equal(result.seasonStats.assists, 0);
  assert.equal(result.competitionStats['UEFA Champions League'].apps, 1);
  assert.equal(result.competitionStats['Club Friendly'], undefined);
});
