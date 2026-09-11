'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { migrationFiles, verifyMigrationInventory } = require('../scripts/d1/migration-inventory');

const root = path.join(__dirname, '..');

test('migration verification derives the exact inventory from the repository', () => {
  const expected = migrationFiles(root);
  const rows = expected.map((name, index) => ({ id: index + 1, name }));
  const report = verifyMigrationInventory(expected, rows);
  assert.equal(report.exact, true);
  assert.deepEqual(report.pending, []);
});

test('migration verification permits only an exact prefix before apply', () => {
  const expected = migrationFiles(root);
  const report = verifyMigrationInventory(expected,
    expected.slice(0, -1).map(name => ({ name })), { allowPending: true });
  assert.deepEqual(report.pending, [expected.at(-1)]);
  assert.throws(() => verifyMigrationInventory(expected,
    [{ name: expected[0] }, { name: '0002_unexpected.sql' }], { allowPending: true }), /inventory drift/);
  assert.throws(() => verifyMigrationInventory(expected,
    expected.slice(0, -1).map(name => ({ name }))), /inventory is incomplete/);
});
