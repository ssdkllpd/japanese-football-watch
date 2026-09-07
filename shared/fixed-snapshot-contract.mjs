export const FIXED_SNAPSHOT_SCHEMA_VERSION = 'd1-fixed-snapshot/1';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Hex(value) {
  const content = typeof value === 'string' ? value : stableStringify(value);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function snapshotPayload(snapshot) {
  const { inputSha256: ignored, ...payload } = snapshot;
  return payload;
}

export function fixedSnapshotR2Key(artifactSha256) {
  return `migration/fixed-snapshots/${artifactSha256}.json`;
}

export function membershipKey(membership, seasonStartsOn) {
  return [
    String(membership.club || ''),
    String(membership.league || ''),
    membership.from || seasonStartsOn,
    membership.to || '9999-12-31',
    String(membership.changeType || 'legacy'),
  ].join('|');
}

export function aggregatePayload(player) {
  return {
    profile: {
      name: player.name || null,
      position: player.pos || null,
      currentClub: player.currentClub || player.club || null,
      currentLeague: player.currentLeague || player.league || null,
      trackingStatus: player.trackingStatus || 'active',
    },
    seasonStats: player.seasonStats || player.stats || {},
    allCompetitionsStats: player.allCompetitionsStats || {},
    competitionStats: player.competitionStats || {},
    clubStats: player.clubStats || {},
    clubCompetitionStats: player.clubCompetitionStats || {},
    _aggregateBaselines: player._aggregateBaselines || {},
    statsScope: player.statsScope || null,
    statsStatus: player.statsStatus || null,
    statsAsOf: player.statsAsOf || null,
    statsTrackingState: player.statsTrackingState || null,
    _initialStats: player._initialStats || {},
    _initialClub: player._initialClub || null,
    _initialLeague: player._initialLeague || null,
    _initialStatsCaptured: player._initialStatsCaptured ?? null,
    _initialStatsUpdated: player._initialStatsUpdated || null,
  };
}

function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function canonicalInstant(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(value || ''))) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function structuralErrors(snapshot) {
  const errors = [];
  if (snapshot?.schemaVersion !== FIXED_SNAPSHOT_SCHEMA_VERSION) errors.push('unsupported snapshot schemaVersion');
  if (!/^\d{4}-\d{2}$/.test(snapshot?.season?.id || '')) errors.push('season.id must be YYYY-YY');
  if (!realDate(snapshot?.season?.startsOn)) errors.push('season.startsOn must be a real YYYY-MM-DD date');
  if (!realDate(snapshot?.season?.endsOn)) errors.push('season.endsOn must be a real YYYY-MM-DD date');
  if (snapshot?.season?.startsOn > snapshot?.season?.endsOn) errors.push('season date range is inverted');
  if (!canonicalInstant(snapshot?.createdAt)) errors.push('createdAt must be a canonical UTC instant');
  if (!Array.isArray(snapshot?.data?.players)) errors.push('data.players must be an array');
  if (!Array.isArray(snapshot?.data?.playerMatchStats)) errors.push('data.playerMatchStats must be an array');

  const players = snapshot?.data?.players || [];
  const records = snapshot?.data?.playerMatchStats || [];
  if (Array.isArray(snapshot?.data?.players) && players.length === 0) {
    errors.push('data.players must not be empty');
  }
  const playerIds = new Set();
  for (const player of players) {
    if (typeof player?.playerId !== 'string' || !player.playerId) errors.push('playerId is required');
    if (playerIds.has(player?.playerId)) errors.push(`duplicate playerId: ${player.playerId}`);
    playerIds.add(player?.playerId);
    if (!['active', 'out_of_scope', 'unattached'].includes(player?.trackingStatus || 'active')) {
      errors.push(`unsupported trackingStatus: ${player?.playerId || 'unknown'}`);
    }
    const seen = new Set();
    const periods = [];
    for (const membership of player?.membershipHistory || []) {
      if (!membership?.club || !membership?.league) {
        errors.push(`legacy membership requires club and league: ${player?.playerId || 'unknown'}`);
        continue;
      }
      const validFrom = membership.from || snapshot?.season?.startsOn;
      const validTo = membership.to || '9999-12-31';
      if (!realDate(validFrom) || !realDate(validTo) || validFrom > validTo) {
        errors.push(`legacy membership has an invalid period: ${player?.playerId || 'unknown'}`);
      }
      periods.push({ from: validFrom, to: validTo });
      const identity = membershipKey(membership, snapshot?.season?.startsOn);
      if (seen.has(identity)) errors.push(`duplicate legacy membership: ${player?.playerId}:${identity}`);
      seen.add(identity);
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
    if (typeof record?.recordId !== 'string' || !record.recordId) errors.push('playerMatchStats.recordId is required');
    if (recordIds.has(record?.recordId)) errors.push(`duplicate recordId: ${record.recordId}`);
    recordIds.add(record?.recordId);
    if (!playerIds.has(record?.playerId)) errors.push(`record references unknown playerId: ${record?.recordId}`);
  }
  return errors;
}

export async function validateFixedSnapshot(snapshot, expected = {}) {
  const errors = structuralErrors(snapshot);
  const productSeasonId = `jfw:season:${snapshot?.season?.id || ''}`;
  if (expected.productSeasonId !== undefined && expected.productSeasonId !== productSeasonId) {
    errors.push('fixed snapshot product season differs from the declared scope');
  }
  const inputSha256 = await sha256Hex(stableStringify(snapshotPayload(snapshot || {})));
  if (snapshot?.inputSha256 !== inputSha256) errors.push('inputSha256 does not match fixed snapshot content');
  const artifactSha256 = await sha256Hex(stableStringify(snapshot || {}));
  if (expected.artifactSha256 !== undefined && expected.artifactSha256 !== artifactSha256) {
    errors.push('fixed snapshot artifact SHA-256 differs from the declared scope');
  }
  return { errors, artifactSha256, inputSha256, productSeasonId };
}

export async function assertValidFixedSnapshot(snapshot, expected) {
  const validation = await validateFixedSnapshot(snapshot, expected);
  if (validation.errors.length) {
    throw new Error(`Invalid fixed snapshot:\n- ${validation.errors.join('\n- ')}`);
  }
  return validation;
}
