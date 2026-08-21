const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRuntimeContext } = require('../scripts/shared/runtime-data-loader');

const ROOT = path.join(__dirname, '..');

function harness(mode = 'missing_fragment') {
  const season = '2026-27';
  const seasons = { current: season, seasons: [{ id: season, data: 'data.json' }] };
  const player = {
    playerId: 'jp-test',
    name: 'テスト選手',
    club: 'Club A',
    league: 'プレミアリーグ',
    stats: { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 },
  };
  const context = createRuntimeContext(ROOT, season, {
    updated: 'base',
    players: [player],
    matches: [],
    topMatches: [],
  }, seasons);
  context.console = { log() {}, warn() {}, error() {} };
  context.fetch = async url => {
    const clean = String(url).replace(/[?&]v=\d+$/, '');
    if (clean === 'config/player-registry.json') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ players: [{ playerId: 'jp-test', name: 'テスト選手', aliases: [], providerIds: {} }] }),
      };
    }
    if (clean.includes('index.json')) {
      const fragments = mode === 'unknown_player' ? ['unknown-player.json'] : ['missing.json'];
      return { ok: true, status: 200, json: async () => ({ fragments }) };
    }
    if (clean.includes('unknown-player.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          updated: '2026-08-21T19:00:00+09:00',
          playerUpdates: [{ name: '新加入太郎', club: 'Club B', league: 'プレミアリーグ' }],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backfill-loader.js'), 'utf8'), context, { filename: 'backfill-loader.js' });
  return { context, main: context.document.querySelector('main') };
}

test('current-season structural overlay failure blocks stale base rendering', async () => {
  const { context, main } = harness('missing_fragment');
  await context.window.JFWBackfill.boot();
  assert.equal(context.D._dataIntegrity?.blocked, true);
  assert.equal(context.D._dataIntegrity?.degraded, false);
  assert.equal(context.D._dataIntegrity?.reason, 'current_season_overlay_load_failed');
  assert.equal(main.hidden, true);
});

test('registry-missing player degrades only that identity and keeps the site visible', async () => {
  const { context, main } = harness('unknown_player');
  await context.window.JFWBackfill.boot();

  assert.equal(context.D._dataIntegrity?.blocked, false);
  assert.equal(context.D._dataIntegrity?.degraded, true);
  assert.equal(context.D._dataIntegrity?.reason, 'player_registry_missing_entries');
  assert.equal(main.hidden, false);
  assert.equal(context.D.players.some(player => player.name === '新加入太郎'), false);
  assert.equal(context.D._dataIntegrity?.missingPlayers?.[0]?.name, '新加入太郎');
  assert.ok(context.document.getElementById('dataIntegrityWarning'));
});
