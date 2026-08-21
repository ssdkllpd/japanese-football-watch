'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClientFromEnv } = require('./client');

const ROOT = path.join(__dirname, '..', '..');
const FIELD_MAP_PATH = path.join(ROOT, 'config', 'api-football-schema-v2-map.json');

function descend(values, token) {
  const isArray = token.endsWith('[]');
  const key = isArray ? token.slice(0, -2) : token;
  const next = [];
  for (const value of values) {
    if (value === null || value === undefined || typeof value !== 'object') continue;
    const child = value[key];
    if (isArray) {
      if (Array.isArray(child)) next.push(...child);
    } else if (child !== undefined) {
      next.push(child);
    }
  }
  return next;
}

function pathPresent(root, providerPath) {
  let values = [root];
  for (const token of String(providerPath).split('.')) {
    values = descend(values, token);
    if (!values.length) return false;
  }
  return values.some(value => value !== null && value !== undefined);
}

function inventoryFixture(fixture, fieldMap) {
  const fields = {};
  for (const [target, mapping] of Object.entries(fieldMap.fieldMappings || {})) {
    const presentPaths = (mapping.providerPaths || []).filter(providerPath => pathPresent(fixture, providerPath));
    fields[target] = {
      status: presentPaths.length ? 'present' : 'not_observed',
      presentPaths,
      configuredPaths: mapping.providerPaths || [],
    };
  }
  const entries = Object.values(fields);
  return {
    targetsConfigured: entries.length,
    targetsObserved: entries.filter(entry => entry.status === 'present').length,
    targetsNotObserved: entries.filter(entry => entry.status !== 'present').length,
    fields,
  };
}

async function main() {
  const fixtureId = String(process.env.API_FOOTBALL_FIXTURE_ID || '').trim();
  if (!fixtureId) throw new Error('API_FOOTBALL_FIXTURE_ID is required.');

  const fieldMap = JSON.parse(fs.readFileSync(FIELD_MAP_PATH, 'utf8'));
  const client = createClientFromEnv();
  const { data, quota } = await client.get('/fixtures', {
    id: fixtureId,
    timezone: process.env.API_FOOTBALL_TIMEZONE || 'Asia/Tokyo',
  });
  const fixture = data?.response?.[0];
  if (!fixture) throw new Error(`Fixture ${fixtureId} was not returned by API-Football.`);

  const inventory = inventoryFixture(fixture, fieldMap);
  const output = {
    provider: 'api-football',
    fixtureId: fixture?.fixture?.id ?? fixtureId,
    fixtureStatus: fixture?.fixture?.status?.short ?? null,
    leagueId: fixture?.league?.id ?? null,
    season: fixture?.league?.season ?? null,
    responseResults: data?.results ?? null,
    inventory,
    quota: {
      dailyRemaining: quota?.dailyRemaining ?? null,
      minuteRemaining: quota?.minuteRemaining ?? null,
    },
    security: {
      apiKeyPrinted: false,
      rawResponsePrinted: false,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`API-Football field inventory: FAILED - ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  inventoryFixture,
  pathPresent,
};
