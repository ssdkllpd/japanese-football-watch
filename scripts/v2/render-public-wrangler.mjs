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

const TARGET_FIELDS = new Set([
  'schemaVersion', 'workerName', 'workerOrigin', 'appOrigin', 'r2BucketName',
  'd1DatabaseName', 'd1DatabaseId', 'liveCompetitionIds', 'd1ReadFlags',
  'd1CutoverAuthorization', 'd1ReadProbes',
]);
const AUTHORIZATION_FIELDS = new Set([
  'schemaVersion', 'databaseId', 'migrationWorkflowRunId', 'migrationCommit',
  'migrationTree', 'migrationArtifactSha256', 'authorizedFlags',
]);
const PROBE_FIELDS = new Set([
  'date', 'competitionId', 'standingsCompetitionId', 'standingsSeasonId', 'fixtureId',
]);

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`${name} contains unsupported fields: ${unknown.join(', ')}.`);
}

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
  if (target?.schemaVersion !== 'jfw-public-worker-target/2') {
    throw new Error('Public Worker target schemaVersion is unsupported.');
  }
  exactKeys(target, TARGET_FIELDS, 'Public Worker target');
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
  exactKeys(target.d1ReadFlags, new Set(FLAG_NAMES), 'd1ReadFlags');
  for (const name of FLAG_NAMES) {
    if (typeof target.d1ReadFlags[name] !== 'boolean') {
      throw new Error(`${name} must be boolean.`);
    }
  }

  const enabledFlags = FLAG_NAMES.filter(name => target.d1ReadFlags[name]);
  if (enabledFlags.length) {
    const authorization = target.d1CutoverAuthorization;
    exactKeys(authorization, AUTHORIZATION_FIELDS, 'd1CutoverAuthorization');
    if (authorization.schemaVersion !== 'jfw-d1-public-read-authorization/1') {
      throw new Error('d1CutoverAuthorization schemaVersion is unsupported.');
    }
    if (authorization.databaseId !== target.d1DatabaseId) {
      throw new Error('d1CutoverAuthorization databaseId does not match the Worker target.');
    }
    if (!Number.isInteger(authorization.migrationWorkflowRunId)
        || authorization.migrationWorkflowRunId <= 0) {
      throw new Error('d1CutoverAuthorization migrationWorkflowRunId is invalid.');
    }
    requiredString(authorization.migrationCommit, 'migrationCommit', /^[0-9a-f]{40}$/);
    requiredString(authorization.migrationTree, 'migrationTree', /^[0-9a-f]{40}$/);
    requiredString(
      authorization.migrationArtifactSha256, 'migrationArtifactSha256', /^[0-9a-f]{64}$/,
    );
    if (!Array.isArray(authorization.authorizedFlags)
        || authorization.authorizedFlags.some(name => !FLAG_NAMES.includes(name))
        || new Set(authorization.authorizedFlags).size !== authorization.authorizedFlags.length) {
      throw new Error('d1CutoverAuthorization authorizedFlags is invalid.');
    }
    const unauthorized = enabledFlags.filter(name => !authorization.authorizedFlags.includes(name));
    if (unauthorized.length) {
      throw new Error(`D1 read flags are not authorized: ${unauthorized.join(', ')}.`);
    }

    const probes = target.d1ReadProbes;
    exactKeys(probes, PROBE_FIELDS, 'd1ReadProbes');
    requiredString(probes.date, 'd1ReadProbes.date', /^\d{4}-\d{2}-\d{2}$/);
    requiredString(probes.competitionId, 'd1ReadProbes.competitionId', /^af:competition:\d+$/);
    requiredString(
      probes.standingsCompetitionId,
      'd1ReadProbes.standingsCompetitionId',
      /^af:competition:\d+$/,
    );
    requiredString(probes.standingsSeasonId, 'd1ReadProbes.standingsSeasonId', /^af:season:\d+:\d{4}$/);
    requiredString(probes.fixtureId, 'd1ReadProbes.fixtureId', /^af:fixture:\d+$/);
    for (const competitionId of [probes.competitionId, probes.standingsCompetitionId]) {
      const providerId = Number(competitionId.slice('af:competition:'.length));
      if (!target.liveCompetitionIds.includes(providerId)) {
        throw new Error(`${competitionId} is not in liveCompetitionIds.`);
      }
    }
    const seasonCompetition = probes.standingsSeasonId.split(':')[2];
    if (probes.standingsCompetitionId !== `af:competition:${seasonCompetition}`) {
      throw new Error('The standings probe season does not match its competition.');
    }
  }
  return Object.freeze(target);
}

export function renderPublicWrangler(target, outputPath, options = {}) {
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
    ...FLAG_NAMES.map(name => `${name} = "${options.disableD1Reads ? false : target.d1ReadFlags[name]}"`),
    '',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = loadPublicWorkerTarget(args.manifest);
  const rendered = renderPublicWrangler(target, args.output, {
    disableD1Reads: process.argv.slice(2).includes('--disable-d1-reads'),
  });
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
