'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClientFromEnv } = require('../api-football/client');
const {
  discoveryDates,
  emptyAutomationState,
  planAutomation,
  validatePolicy,
  validateState,
} = require('./api-football-automation-plan');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) result[key.slice(2)] = true;
    else { result[key.slice(2)] = value; index += 1; }
  }
  return result;
}

function readJson(filePath, fallback, label) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function discoverAutomation(options) {
  const policy = validatePolicy(options.policy);
  const state = validateState(options.state || emptyAutomationState());
  const now = new Date(options.now || Date.now());
  const dates = discoveryDates(policy, now);
  const fixturesByDate = {};
  const statusQuota = await options.client.refreshDailyQuota();
  let quota = statusQuota;
  for (const date of dates) {
    const result = await options.client.get('fixtures', { date, timezone: policy.timeZone });
    fixturesByDate[date] = Array.isArray(result?.data?.response) ? result.data.response : [];
    quota = result.quota || quota;
  }
  return {
    plan: planAutomation({
      policy, state, fixturesByDate, now,
      quota, preview: options.preview === true,
    }),
    fixturesByDate,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.policy || !args.out) {
    throw new Error('Usage: discover-api-football-automation.js --policy FILE --state FILE --out DIR [--preview true]');
  }
  const policy = readJson(path.resolve(args.policy), null, 'Automation policy');
  const statePath = args.state ? path.resolve(args.state) : null;
  const state = readJson(statePath, emptyAutomationState(), 'Automation state');
  const outputDir = path.resolve(args.out);
  const result = await discoverAutomation({
    policy, state, client: createClientFromEnv(process.env),
    now: args.now || Date.now(), preview: String(args.preview || '').toLowerCase() === 'true',
  });
  writeJson(path.join(outputDir, 'plan.json'), result.plan);
  for (const [date, rows] of Object.entries(result.fixturesByDate)) {
    writeJson(path.join(outputDir, 'discovery', `${date}.json`), { date, response: rows });
  }
  process.stdout.write(`${JSON.stringify({ outputDir, plan: result.plan }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
}

module.exports = { discoverAutomation, parseArgs, readJson, writeJson };
