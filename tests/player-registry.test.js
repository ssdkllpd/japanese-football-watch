'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildPlayerRegistryIndexes } = require('../scripts/api-football/backfill-existing-results');

const ROOT = path.join(__dirname, '..');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'player-registry.json'), 'utf8'));

test('player registry stores identity only and records ID provenance', () => {
  assert.ok(Array.isArray(registry.players) && registry.players.length > 0);
  for (const player of registry.players) {
    assert.equal(player.idSource, 'legacy_name_hash_migration_2026-08-21', `${player.name}: idSource missing`);
    const apiFootball = player?.providerIds?.apiFootball;
    if (!apiFootball) continue;
    assert.deepEqual(Object.keys(apiFootball).sort(), ['player'], `${player.name}: mutable API-Football state leaked into identity registry`);
  }
});

test('川﨑颯太 registry identity resolves the common 川崎颯太 spelling alias', () => {
  const indexes = buildPlayerRegistryIndexes(registry);
  const canonical = indexes.byName.get('川﨑颯太');
  const common = indexes.byName.get('川崎颯太');
  assert.ok(canonical);
  assert.ok(common);
  assert.equal(common.playerId, canonical.playerId);
  assert.equal(canonical.playerId, 'jp-tcfkg2');
});
