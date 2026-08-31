#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const outputIndex = argv.indexOf('--output');
  if (outputIndex === -1 || !argv[outputIndex + 1]) {
    throw new Error('Usage: render-admin-wrangler.mjs --output FILE');
  }
  return { output: path.resolve(argv[outputIndex + 1]) };
}

function required(env, key, expression) {
  const value = env[key];
  if (typeof value !== 'string' || !expression.test(value)) throw new Error(`${key} is missing or invalid.`);
  return value;
}

function tomlPath(fromDirectory, target) {
  const relative = path.relative(fromDirectory, target).split(path.sep).join('/');
  return JSON.stringify(relative.startsWith('.') ? relative : `./${relative}`);
}

export function renderAdminWrangler(env, outputPath) {
  const workerName = required(env, 'ADMIN_WORKER_NAME', /^[a-z0-9][a-z0-9-]{0,62}$/);
  const bucketName = required(env, 'R2_BUCKET', /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/);
  const databaseName = required(env, 'D1_DATABASE_NAME', /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/);
  const databaseId = required(env, 'D1_DATABASE_ID', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outputDirectory = path.dirname(path.resolve(outputPath));
  return [
    `name = ${JSON.stringify(workerName)}`,
    `main = ${tomlPath(outputDirectory, path.join(root, 'admin-worker', 'index.mjs'))}`,
    'compatibility_date = "2026-08-31"',
    'compatibility_flags = ["nodejs_compat"]',
    `migrations_dir = ${tomlPath(outputDirectory, path.join(root, 'migrations'))}`,
    '',
    '[[r2_buckets]]',
    'binding = "FOOTBALL_DATA"',
    `bucket_name = ${JSON.stringify(bucketName)}`,
    '',
    '[[d1_databases]]',
    'binding = "FOOTBALL_DB"',
    `database_name = ${JSON.stringify(databaseName)}`,
    `database_id = ${JSON.stringify(databaseId)}`,
    '',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = renderAdminWrangler(process.env, args.output);
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, config, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${args.output}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
