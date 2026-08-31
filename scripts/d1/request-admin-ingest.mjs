#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLAN_VERSION = 'jfw-d1-admin-ingest-plan/1';
const REQUEST_VERSION = 'jfw-d1-admin-ingest/1';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) result[key] = true;
    else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function canonical(value, expression, label) {
  if (typeof value !== 'string' || !expression.test(value)) throw new Error(`${label} is invalid.`);
}

function resolveArtifact(root, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a relative path.`);
  }
  const base = fs.realpathSync(root);
  const resolved = path.resolve(base, relativePath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} escapes the plan directory.`);
  const real = fs.realpathSync(resolved);
  const realRelative = path.relative(base, real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`${label} escapes the plan directory through a link.`);
  }
  return JSON.parse(fs.readFileSync(real, 'utf8'));
}

function validatePlan(plan, directory) {
  if (plan?.schemaVersion !== PLAN_VERSION) throw new Error(`schemaVersion must be ${PLAN_VERSION}.`);
  if (!Array.isArray(plan.standings) || !Array.isArray(plan.fixtures)) {
    throw new Error('standings and fixtures must be arrays.');
  }
  if (plan.standings.length + plan.fixtures.length === 0) throw new Error('Admin ingest plan is empty.');
  const requests = [];
  for (const [index, item] of plan.standings.entries()) {
    canonical(item?.competitionId, /^af:competition:\d+$/, `standings[${index}].competitionId`);
    canonical(item?.seasonId, /^af:season:\d+:\d+$/, `standings[${index}].seasonId`);
    requests.push({
      schemaVersion: REQUEST_VERSION, operation: 'standings_publish',
      competitionId: item.competitionId, seasonId: item.seasonId,
    });
  }
  for (const [index, item] of plan.fixtures.entries()) {
    canonical(item?.fixtureId, /^af:fixture:\d+$/, `fixtures[${index}].fixtureId`);
    canonical(item?.competitionId, /^af:competition:\d+$/, `fixtures[${index}].competitionId`);
    canonical(item?.seasonId, /^af:season:\d+:\d+$/, `fixtures[${index}].seasonId`);
    requests.push({
      schemaVersion: REQUEST_VERSION, operation: 'fixture_publish',
      fixtureId: item.fixtureId, competitionId: item.competitionId, seasonId: item.seasonId,
      catalog: resolveArtifact(directory, item.catalogPath, `fixtures[${index}].catalogPath`),
      correctionDefinitions: resolveArtifact(
        directory, item.correctionsPath, `fixtures[${index}].correctionsPath`,
      ),
    });
  }
  const identities = requests.map(item => item.operation === 'fixture_publish'
    ? `${item.operation}\t${item.fixtureId}`
    : `${item.operation}\t${item.competitionId}\t${item.seasonId}`);
  if (new Set(identities).size !== identities.length) throw new Error('Admin ingest plan contains duplicate scopes.');
  return requests;
}

function endpoint(value) {
  const parsed = new URL(value);
  if (parsed.username || parsed.password) throw new Error('Admin ingest URL must not contain credentials.');
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new Error('Admin ingest URL must use HTTPS.');
  }
  parsed.pathname = '/admin/v1/ingest';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export async function executeAdminIngestPlan(plan, options) {
  if (typeof options?.token !== 'string' || !options.token) throw new Error('Admin ingest token is required.');
  const requests = validatePlan(plan, options.planDirectory);
  const url = endpoint(options.url);
  const fetchImpl = options.fetchImpl || fetch;
  const results = [];
  for (const request of requests) {
    const identity = request.operation === 'fixture_publish'
      ? request.fixtureId : `${request.competitionId}/${request.seasonId}`;
    try {
      const response = await fetchImpl(url, {
        method: 'POST', redirect: 'error',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) {
        results.push({ operation: request.operation, identity, passed: false, status: response.status });
      } else {
        results.push({ operation: request.operation, identity, passed: true, status: response.status, report: body.report });
      }
    } catch (error) {
      results.push({ operation: request.operation, identity, passed: false, status: null,
        error: error?.name || 'request_failed' });
    }
  }
  return {
    schemaVersion: 'jfw-d1-admin-ingest-client-report/1',
    results,
    summary: {
      total: results.length, passed: results.filter(item => item.passed).length,
      failed: results.filter(item => !item.passed).length,
    },
    passed: results.every(item => item.passed),
    productionReady: false,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['--url'] || !args['--plan'] || !args['--report']) {
    throw new Error('Usage: request-admin-ingest.mjs --url URL --plan FILE --report FILE');
  }
  const token = process.env.ADMIN_INGEST_TOKEN;
  const planPath = path.resolve(args['--plan']);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const report = await executeAdminIngestPlan(plan, {
    url: args['--url'], token, planDirectory: path.dirname(planPath),
  });
  fs.mkdirSync(path.dirname(path.resolve(args['--report'])), { recursive: true });
  fs.writeFileSync(path.resolve(args['--report']), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
