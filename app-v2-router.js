(function initFootballRouter(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FootballV2Router = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const MATCH_FILTERS = new Set(['all', 'live', 'following', 'japanese']);
  const FIXTURE_TABS = new Set(['overview', 'lineup', 'events', 'stats', 'ratings']);
  const COMPETITION_TABS = new Set(['matches', 'standings', 'overview', 'players', 'teams']);
  const LEGACY_HASHES = new Map([
    ['#home', '#/matches'],
    ['#featured', '#/matches'],
    ['#matches', '#/matches'],
    ['#stats', '#/japanese'],
    ['#ga', '#/japanese'],
    ['#insights', '#/japanese'],
    ['#attention', '#/japanese'],
    ['#coverage', '#/more'],
  ]);

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const parsed = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function parseHash(input, defaults = {}) {
    const rawHash = String(input || '').trim();
    const [legacyPath, legacyQuery = ''] = rawHash.split('?');
    const mapped = LEGACY_HASHES.get(legacyPath);
    const migrated = mapped ? `${mapped}${legacyQuery ? `?${legacyQuery}` : ''}` : null;
    if (!migrated && rawHash && rawHash !== '#' && !rawHash.startsWith('#/')) return notFound('entity_not_found', false);
    const hash = migrated || (rawHash === '#/' ? '#/matches' : rawHash.startsWith('#/') ? rawHash : '#/matches');
    const [rawPath, rawQuery = ''] = hash.slice(1).split('?');
    const segments = rawPath.split('/').filter(Boolean);
    const decoded = segments.map(safeDecode);
    const params = new URLSearchParams(rawQuery);
    if (decoded.some(value => value === null)) return notFound('malformed_route', migrated);

    if (decoded.length === 1 && decoded[0] === 'matches') {
      const requestedFilter = params.get('filter');
      const legacyLive = params.get('live') === '1';
      const filter = MATCH_FILTERS.has(requestedFilter) ? requestedFilter : (legacyLive ? 'live' : 'all');
      const date = validDate(params.get('date')) ? params.get('date') : (validDate(defaults.date) ? defaults.date : null);
      return {
        kind: 'matches', page: 'matches', date, filter,
        canonicalHash: matchesHash(date, filter),
        shouldReplace: Boolean(migrated || rawHash === '#/' || !validDate(params.get('date')) || !MATCH_FILTERS.has(requestedFilter) || params.has('live')),
      };
    }

    if (decoded.length === 2 && decoded[0] === 'fixtures' && decoded[1]) {
      const tab = FIXTURE_TABS.has(params.get('tab')) ? params.get('tab') : 'overview';
      const ratingMode = params.get('ratingMode') === 'jfw' ? 'jfw' : 'provider';
      return {
        kind: 'fixture', page: defaults.fixtureReturn || 'matches', fixtureId: decoded[1], tab,
        playerId: params.get('player') || null, ratingMode,
        canonicalHash: fixtureHash(decoded[1], { tab, playerId: params.get('player'), ratingMode }),
        shouldReplace: false,
      };
    }

    if (decoded.length === 1 && decoded[0] === 'competitions') {
      return { kind: 'competitions', page: 'leagues', canonicalHash: '#/competitions', shouldReplace: Boolean(migrated) };
    }

    if (decoded.length === 2 && decoded[0] === 'competitions' && decoded[1]) {
      const seasonId = params.get('competitionSeason');
      if (seasonId && !seasonId.startsWith('af:season:')) return invalidSeason('competitionSeason', seasonId);
      const tab = COMPETITION_TABS.has(params.get('tab')) ? params.get('tab') : 'matches';
      const date = validDate(params.get('date')) ? params.get('date') : null;
      return {
        kind: 'competition', page: 'leagues', competitionId: decoded[1], competitionSeason: seasonId || null, tab, date,
        canonicalHash: competitionHash(decoded[1], seasonId, tab, date), shouldReplace: false,
      };
    }

    if (decoded.length === 2 && ['teams', 'players'].includes(decoded[0]) && decoded[1]) {
      const seasonId = params.get('productSeason');
      if (seasonId && !seasonId.startsWith('jfw:season:')) return invalidSeason('productSeason', seasonId);
      const kind = decoded[0] === 'teams' ? 'team' : 'player';
      return {
        kind, page: defaults.returnPage || 'leagues', entityId: decoded[1], productSeason: seasonId || null,
        canonicalHash: entityHash(decoded[0], decoded[1], seasonId), shouldReplace: false,
      };
    }

    if (decoded.length === 1 && decoded[0] === 'search') {
      return { kind: 'search', page: defaults.returnPage || 'matches', query: params.get('q') || '', canonicalHash: searchHash(params.get('q') || ''), shouldReplace: false };
    }

    if (decoded.length === 1 && ['following', 'japanese', 'more'].includes(decoded[0])) {
      const page = decoded[0];
      const seasonId = page === 'japanese' ? params.get('productSeason') : null;
      if (seasonId && !seasonId.startsWith('jfw:season:')) return invalidSeason('productSeason', seasonId);
      return { kind: page, page, productSeason: seasonId || null, canonicalHash: pageHash(page, seasonId), shouldReplace: Boolean(migrated) };
    }

    return notFound('entity_not_found', migrated);
  }

  function notFound(code, migrated) {
    return { kind: 'error', status: 404, code, page: 'matches', canonicalHash: '#/404', shouldReplace: Boolean(migrated) };
  }

  function invalidSeason(parameter, value) {
    return { kind: 'error', status: 400, code: 'invalid_season_namespace', parameter, value, page: 'matches', canonicalHash: '#/400', shouldReplace: false };
  }

  function withParams(path, entries) {
    const params = new URLSearchParams();
    for (const [key, value] of entries) if (value !== null && value !== undefined && value !== '') params.set(key, value);
    const query = params.toString();
    return `#${path}${query ? `?${query}` : ''}`;
  }

  function matchesHash(date, filter = 'all') {
    return withParams('/matches', [['date', date], ['filter', MATCH_FILTERS.has(filter) ? filter : 'all']]);
  }

  function fixtureHash(fixtureId, options = {}) {
    const tab = FIXTURE_TABS.has(options.tab) ? options.tab : 'overview';
    return withParams(`/fixtures/${encodeURIComponent(fixtureId)}`, [
      ['tab', tab],
      ['player', options.playerId],
      ['ratingMode', tab === 'ratings' ? options.ratingMode : null],
    ]);
  }

  function competitionHash(competitionId, seasonId, tab = 'matches', date = null) {
    return withParams(`/competitions/${encodeURIComponent(competitionId)}`, [
      ['competitionSeason', seasonId],
      ['date', date],
      ['tab', COMPETITION_TABS.has(tab) ? tab : 'matches'],
    ]);
  }

  function entityHash(collection, entityId, seasonId) {
    return withParams(`/${collection}/${encodeURIComponent(entityId)}`, [['productSeason', seasonId]]);
  }

  function searchHash(query) {
    return withParams('/search', [['q', query]]);
  }

  function pageHash(page, seasonId) {
    return withParams(`/${page === 'leagues' ? 'competitions' : page}`,  page === 'japanese' ? [['productSeason', seasonId]] : []);
  }

  function migrateLegacy(search, hash, candidates = {}) {
    const outer = new URLSearchParams(search);
    const [oldPath, query = ''] = String(hash || '').split('?');
    const isLegacy = LEGACY_HASHES.has(oldPath);
    if (oldPath && oldPath !== '#' && oldPath !== '#/' && !isLegacy) return null;
    const inner = new URLSearchParams(isLegacy ? query : '');
    const value = key => outer.get(key) || inner.get(key);
    const player = value('player'), club = value('club'), season = value('season');
    if (!player && !club && !season) return null;
    const seasonId = /^\d{4}-\d{2}$/.test(season || '') ? `jfw:season:${season}` : null;
    const unique = (items, name, prefix) => {
      const ids = [...new Set((items || []).filter(item => item.name === name && String(item.id).startsWith(prefix)).map(item => item.id))];
      return ids.length === 1 ? ids[0] : null;
    };
    let result = LEGACY_HASHES.get(oldPath) || '#/japanese';
    if (player) {
      const id = unique(candidates.players,player,'af:player:');
      result = id ? entityHash('players',id,seasonId) : pageHash('japanese',seasonId);
    } else if (club) {
      const id = unique(candidates.teams,club,'af:team:');
      result = id ? entityHash('teams',id,seasonId) : '#/competitions';
    } else if (seasonId) result = pageHash('japanese',seasonId);
    for (const key of ['player','club','season']) { outer.delete(key); inner.delete(key); }
    const remaining = inner.toString();
    if (remaining) result += `${result.includes('?') ? '&' : '?'}${remaining}`;
    return { hash:result, search:outer.toString() ? `?${outer}` : '' };
  }

  return {
    migrateLegacy,
    MATCH_FILTERS,
    FIXTURE_TABS,
    COMPETITION_TABS,
    parseHash,
    matchesHash,
    fixtureHash,
    competitionHash,
    entityHash,
    searchHash,
    pageHash,
  };
});
