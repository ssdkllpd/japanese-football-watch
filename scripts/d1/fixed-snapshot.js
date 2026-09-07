'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { mergeBackfillData } = require('../../backfill-merge');

const SNAPSHOT_SCHEMA_VERSION = 'd1-fixed-snapshot/1';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  const content = typeof value === 'string' || Buffer.isBuffer(value) ? value : stableStringify(value);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function snapshotPayload(snapshot) {
  const { inputSha256: ignored, ...payload } = snapshot;
  return payload;
}

function artifactSha256(snapshot) {
  return sha256(stableStringify(snapshot));
}

function membershipKey(membership, seasonStartsOn) {
  return [
    String(membership.club || ''),
    String(membership.league || ''),
    membership.from || seasonStartsOn,
    membership.to || '9999-12-31',
    String(membership.changeType || 'legacy'),
  ].join('|');
}

function validateFixedSnapshot(snapshot) {
  const errors = [];
  if (snapshot?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) errors.push('unsupported snapshot schemaVersion');
  if (!/^\d{4}-\d{2}$/.test(snapshot?.season?.id || '')) errors.push('season.id must be YYYY-YY');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot?.season?.startsOn || '')) errors.push('season.startsOn must be YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot?.season?.endsOn || '')) errors.push('season.endsOn must be YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(snapshot?.createdAt || '')) errors.push('createdAt must be UTC ISO');
  if (snapshot?.inputSha256 !== sha256(snapshotPayload(snapshot))) errors.push('inputSha256 does not match fixed snapshot content');

  if (!Array.isArray(snapshot?.data?.players)) errors.push('data.players must be an array');
  if (!Array.isArray(snapshot?.data?.playerMatchStats)) errors.push('data.playerMatchStats must be an array');
  const players = snapshot?.data?.players || [];
  const records = snapshot?.data?.playerMatchStats || [];
  const playerIds = new Set();
  for (const player of players) {
    if (!player.playerId) errors.push(`playerId is required for ${player.name || 'unknown player'}`);
    if (playerIds.has(player.playerId)) errors.push(`duplicate playerId: ${player.playerId}`);
    playerIds.add(player.playerId);

    const seenMemberships = new Set();
    const periods = [];
    for (const membership of player.membershipHistory || []) {
      if (!membership.club || !membership.league) {
        errors.push(`legacy membership requires club and league: ${player.playerId}`);
        continue;
      }
      const validFrom = membership.from || snapshot.season.startsOn;
      const validTo = membership.to || '9999-12-31';
      if (validFrom > validTo) errors.push(`legacy membership has an inverted period: ${player.playerId}`);
      periods.push({ from: validFrom, to: validTo });
      const key = membershipKey(membership, snapshot.season.startsOn);
      if (seenMemberships.has(key)) errors.push(`duplicate legacy membership: ${player.playerId}:${key}`);
      seenMemberships.add(key);
    }
    periods.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
    for (let index = 1; index < periods.length; index += 1) {
      if (periods[index].from < periods[index - 1].to) {
        errors.push(`overlapping legacy membership periods: ${player.playerId}`);
      }
    }
  }

  const recordIds = new Set();
  for (const record of records) {
    if (!record.recordId) errors.push('playerMatchStats.recordId is required');
    if (recordIds.has(record.recordId)) errors.push(`duplicate recordId: ${record.recordId}`);
    recordIds.add(record.recordId);
    if (!playerIds.has(record.playerId)) errors.push(`record references unknown playerId: ${record.recordId}`);
  }
  return errors;
}

function buildFixedSnapshot(options) {
  const {
    baseData,
    basePath = 'data.json',
    createdAt,
    fragmentNames,
    fragments,
    season,
  } = options || {};
  if (!baseData || !Array.isArray(fragments) || !Array.isArray(fragmentNames)) {
    throw new TypeError('baseData, fragments and fragmentNames are required.');
  }
  if (fragments.length !== fragmentNames.length) throw new Error('fragmentNames must match fragments.');

  const merged = mergeBackfillData(baseData, fragments, { season: season.id });
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    createdAt,
    season,
    inputs: {
      base: { path: basePath, sha256: sha256(baseData) },
      fragments: fragmentNames.map((name, index) => ({ path: name, sha256: sha256(fragments[index]) })),
    },
    data: merged,
  };
  snapshot.inputSha256 = sha256(snapshotPayload(snapshot));
  const errors = validateFixedSnapshot(snapshot);
  if (errors.length) throw new Error(`Invalid fixed snapshot:\n- ${errors.join('\n- ')}`);
  return snapshot;
}

function currentSnapshotInputs(rootDirectory, options = {}) {
  const seasons = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'seasons.json'), 'utf8'));
  const seasonId = options.season || seasons.current;
  const seasonEntry = seasons.seasons.find(item => item.id === seasonId);
  if (!seasonEntry) throw new Error(`Unknown season: ${seasonId}`);
  const baseData = JSON.parse(fs.readFileSync(path.join(rootDirectory, seasonEntry.data), 'utf8'));
  const backfillDirectory = path.join(rootDirectory, 'data', seasonId, 'backfill');
  const manifest = JSON.parse(fs.readFileSync(path.join(backfillDirectory, 'index.json'), 'utf8'));
  const fragmentNames = manifest.fragments.map(name => path.join('data', seasonId, 'backfill', name));
  const fragments = manifest.fragments.map(name => JSON.parse(fs.readFileSync(path.join(backfillDirectory, name), 'utf8')));
  return { baseData, basePath: seasonEntry.data, fragmentNames, fragments, seasonId };
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  artifactSha256,
  buildFixedSnapshot,
  currentSnapshotInputs,
  membershipKey,
  sha256,
  stableStringify,
  validateFixedSnapshot,
};
