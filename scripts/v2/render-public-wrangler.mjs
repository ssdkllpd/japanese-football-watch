#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FLAG_NAMES = Object.freeze([
  'D1_DATE_INDEX_ENABLED',
  'D1_COMPETITION_DATE_INDEX_ENABLED',
  'D1_STANDINGS_ENABLED',
  'D1_FIXTURE_DETAIL_ENABLED',
]);

function parseArgs(argv) {
  const manifestIndex = argv.indexOf('--manifest');
  const outputIndex = argv.indexOf('--output');
  if (manifestIndex === -1 || !argv[manifestIndex + 1]
      || outputIndex === -1 || !argv[outputIndex + 1]) {
    throw new Error('Usage: render-public-wrangler.mjs --manifest FILE --output FILE');
  }
  return {
    manifest: path.resolve(argv[manifestIndex + 1]),
    output: path.resolve(argv[outputIndex + 1]),
  };
}

function requiredString(value, name, expression) {
  if (typeof value !== 'string' || !expression.test(value)) {
    throw new Error(`${name} is missing or invalid.`);
  }
  return value;
}

function exactOrigin(value, name) {
  const text = requiredString(value, name, /^https:\/\//);
  let url;
  try { url = new URL(text); } catch { throw new Error(`${name} is invalid.`); }
  if (url.origin !== text || url.username || url.password) throw new Error(`${name} must be an exact HTTPS origin.`);
  return text;
}

function tomlPath(fromDirectory, target) {
  const relative = path.relative(fromDirectory, target).split(path.sep).join('/');
  return JSON.stringify(relative.startsWith('.') ? relative : `./${relative}`);
}

export function loadPublicWorkerTarget(manifestPath) {
  let target;
  try { target = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8')); } catch (error) {
    throw new Error(`Unable to read public Worker target: ${error?.message || error}`);
  }
  if (target?.schemaVersion !== 'jfw-public-worker-target/1') {
    throw new Error('Public Worker target schemaVersion is unsupported.');
  }
  requiredString(target.workerName, 'workerName', /^[a-z0-9][a-z0-9-]{0,62}$/);
  requiredString(target.r2BucketName, 'r2BucketName', /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/);
  requiredString(target.d1DatabaseName, 'd1DatabaseName', /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/);
  requiredString(target.d1DatabaseId, 'd1DatabaseId', /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  exactOrigin(target.workerOrigin, 'workerOrigin');
  exactOrigin(target.appOrigin, 'appOrigin');
  if (new URL(target.workerOrigin).hostname !== `${target.workerName}.ssdkllpd.workers.dev`) {
    throw new Error('workerOrigin does not match workerName and the reviewed workers.dev account subdomain.');
  }
  if (!Array.isArray(target.liveCompetitionIds) || target.liveCompetitionIds.length === 0
      || target.liveCompetitionIds.some(id => !Number.isInteger(id) || id <= 0)
      || new Set(target.liveCompetitionIds).size !== target.liveCompetitionIds.length) {
    throw new Error('liveCompetitionIds must contain unique positive integers.');
  }
  for (const name of FLAG_NAMES) {
    if (target.d1ReadFlags?.[name] !== false) throw new Error(`${name} must remain false for the initial public deployment.`);
  }
  if (Object.keys(target.d1ReadFlags || {}).some(name => !FLAG_NAMES.includes(name))) {
    throw new Error('d1ReadFlags contains an unsupported flag.');
  }
  return Object.freeze(target);
}

export function renderPublicWrangler(target, outputPath) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outputDirectory = path.dirname(path.resolve(outputPath));
  return [
    `name = ${JSON.stringify(target.workerName)}`,
    `main = ${tomlPath(outputDirectory, path.join(root, 'worker', 'index.mjs'))}`,
    'compatibility_date = "2026-08-21"',
    'workers_dev = true',
    '',
    '[[r2_buckets]]',
    'binding = "FOOTBALL_DATA"',
    `bucket_name = ${JSON.stringify(target.r2BucketName)}`,
    '',
    '[[d1_databases]]',
    'binding = "FOOTBALL_DB"',
    `database_name = ${JSON.stringify(target.d1DatabaseName)}`,
    `database_id = ${JSON.stringify(target.d1DatabaseId)}`,
    '',
    '[vars]',
    `APP_ORIGINS = ${JSON.stringify(target.appOrigin)}`,
    'ALLOW_NO_ORIGIN = "false"',
    'SOFT_RATE_LIMIT_PER_MINUTE = "120"',
    `LIVE_COMPETITION_IDS = ${JSON.stringify([...target.liveCompetitionIds].sort((a, b) => a - b).join(','))}`,
    ...FLAG_NAMES.map(name => `${name} = "false"`),
    '',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = loadPublicWorkerTarget(args.manifest);
  const rendered = renderPublicWrangler(target, args.output);
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, rendered, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${args.output}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
