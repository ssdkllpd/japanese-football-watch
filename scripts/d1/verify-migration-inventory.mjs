#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { migrationFiles, verifyMigrationInventory, wranglerMigrationRows } = require('./migration-inventory');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[item.slice(2)] = true;
    else { result[item.slice(2)] = next; index += 1; }
  }
  return result;
}

export function verifyInventoryFile(filePath, options = {}) {
  const payload = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  return verifyMigrationInventory(migrationFiles(), wranglerMigrationRows(payload), options);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inventory) throw new Error('Usage: verify-migration-inventory.mjs --inventory FILE [--allow-pending]');
  const report = verifyInventoryFile(args.inventory, { allowPending: args['allow-pending'] === true });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}
