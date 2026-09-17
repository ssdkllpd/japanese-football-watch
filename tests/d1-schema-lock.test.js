'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('review lock exactly matches authoritative migration DDL', async () => {
  const { checkSchemaLock } = await import('../scripts/d1/check-schema-lock.mjs');
  const result = checkSchemaLock(root, path.join(root, 'config', 'd1-constraints.lock.json'));
  assert.equal(result.tables.fixture_player_stats.columns.some(column => column.name === 'passes_accurate'), true);
  assert.equal(result.tables.fixture_player_stats.columns.some(column => column.name === 'pass_accuracy'), false);
  assert.match(result.tables.fixture_player_stats.ddl, /provider_rating <= 10/);
});

test('schema lock check fails closed on unreviewed drift', async t => {
  const { buildSchemaLock, checkSchemaLock } = await import('../scripts/d1/check-schema-lock.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-schema-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, 'lock.json');
  const lock = buildSchemaLock(root);
  lock.tables.fixture_player_stats.ddl += ' drift';
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  assert.throws(() => checkSchemaLock(root, lockPath), /differs from authoritative migration DDL/);
});
