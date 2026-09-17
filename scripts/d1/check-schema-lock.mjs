#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { applyMigrations, migrationFiles } = require('./migration-inventory');
const TRACKED_TABLES = ['fixture_player_stats', 'fixture_team_stats'];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

export function buildSchemaLock(rootDirectory = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')) {
  const root = path.resolve(rootDirectory);
  const database = new DatabaseSync(':memory:');
  try {
    applyMigrations(database, root);
    const tables = Object.fromEntries(TRACKED_TABLES.map(table => {
      const sql = database.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?')
        .get('table', table)?.sql;
      if (!sql) throw new Error(`Tracked D1 table is missing: ${table}.`);
      const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(row => ({
        name: row.name, type: row.type, notNull: Boolean(row.notnull), primaryKey: row.pk,
      }));
      return [table, { columns, ddl: normalizeSql(sql) }];
    }));
    return {
      schemaVersion: 'jfw-d1-constraints-lock/1',
      migrations: migrationFiles(root).map(name => ({
        name, sha256: sha256(fs.readFileSync(path.join(root, 'migrations', name))),
      })),
      tables,
    };
  } finally {
    database.close();
  }
}

export function checkSchemaLock(rootDirectory, lockPath) {
  const expected = buildSchemaLock(rootDirectory);
  const actual = JSON.parse(fs.readFileSync(path.resolve(lockPath), 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('D1 schema constraint lock differs from authoritative migration DDL.');
  }
  return expected;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const root = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'));
  const lockPath = path.join(root, 'config', 'd1-constraints.lock.json');
  if (args.has('--write')) {
    fs.writeFileSync(lockPath, `${JSON.stringify(buildSchemaLock(root), null, 2)}\n`);
  } else {
    checkSchemaLock(root, lockPath);
  }
  process.stdout.write(`${JSON.stringify({ passed: true, lockPath: path.relative(root, lockPath) })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}
