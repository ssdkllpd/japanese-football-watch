'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

function migrationFiles(rootDirectory = path.join(__dirname, '..', '..')) {
  const directory = path.join(rootDirectory, 'migrations');
  const files = fs.readdirSync(directory).filter(file => MIGRATION_PATTERN.test(file)).sort();
  if (!files.length) throw new Error('No D1 migrations were found.');
  files.forEach((file, index) => {
    const expected = String(index + 1).padStart(4, '0');
    if (MIGRATION_PATTERN.exec(file)[1] !== expected) {
      throw new Error(`D1 migration sequence is not contiguous at ${file}; expected ${expected}.`);
    }
  });
  return files;
}

function applyMigrations(database, rootDirectory, options = {}) {
  const through = options.through || null;
  const files = migrationFiles(rootDirectory);
  const selected = through ? files.filter(file => file <= through) : files;
  if (through && selected.at(-1) !== through) throw new Error(`Unknown migration boundary: ${through}.`);
  for (const file of selected) {
    database.exec(fs.readFileSync(path.join(rootDirectory, 'migrations', file), 'utf8'));
  }
  return selected;
}

function wranglerMigrationRows(payload) {
  if (Array.isArray(payload?.[0]?.results)) return payload[0].results;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload)) return payload;
  throw new Error('Wrangler migration inventory has no results array.');
}

function verifyMigrationInventory(expectedFiles, rows, options = {}) {
  const actual = rows.map(row => row?.name);
  if (actual.some(name => typeof name !== 'string')) throw new Error('D1 migration inventory contains an invalid name.');
  const expectedPrefix = expectedFiles.slice(0, actual.length);
  if (JSON.stringify(actual) !== JSON.stringify(expectedPrefix)) {
    throw new Error(`D1 migration inventory drift: expected prefix ${expectedPrefix.join(', ')}, received ${actual.join(', ')}.`);
  }
  if (!options.allowPending && actual.length !== expectedFiles.length) {
    throw new Error(`D1 migration inventory is incomplete (${actual.length}/${expectedFiles.length}).`);
  }
  return { expected: expectedFiles, actual, pending: expectedFiles.slice(actual.length), exact: actual.length === expectedFiles.length };
}

module.exports = { applyMigrations, migrationFiles, verifyMigrationInventory, wranglerMigrationRows };
