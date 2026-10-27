(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FootballV2Data = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  function normalizeSearchText(value) {
    return String(value ?? '').normalize('NFKC').toLowerCase()
      .replace(/[\u30a1-\u30f6]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60))
      .normalize('NFD')
      // Fold Latin accents without removing Japanese voiced-sound marks.
      .replace(/\p{Script=Latin}\p{M}+/gu, char => char.replace(/\p{M}/gu, ''))
      .normalize('NFC').replace(/[\s.\p{Pd}'’ʼ・·]/gu, '');
  }
  function searchTokens(query) {
    return String(query ?? '').normalize('NFKC').trim().split(/\s+/u)
      .map(normalizeSearchText).filter(Boolean);
  }
  function matchesSearch(query, values) {
    const tokens = searchTokens(query);
    if (!tokens.length) return !String(query ?? '').trim();
    const fields = values.filter(value => value !== null && value !== undefined).map(normalizeSearchText);
    return tokens.every(token => fields.some(field => field.includes(token)));
  }
  function japaneseClubMemberships(profiles) {
    const clubs = new Map();
    for (const player of profiles) {
      if (player.nationality !== 'Japan' || !/^af:player:[1-9]\d*$/.test(String(player.id || ''))) continue;
      for (const team of player.rosterTeams || []) {
        if (!/^af:team:[1-9]\d*$/.test(String(team.id || '')) || !team.name) continue;
        if (!clubs.has(team.id)) clubs.set(team.id, { team, players: new Map() });
        clubs.get(team.id).players.set(player.id, player);
      }
    }
    return new Map([...clubs].map(([id, club]) => [id, { team: club.team, players: [...club.players.values()] }]));
  }
  function presence(value, state) {
    const explicit = typeof state === 'string' ? state : state?.presence;
    if (explicit && explicit !== 'present') return explicit;
    return value === null || value === undefined ? (explicit === 'present' ? 'provider_missing' : 'not_fetched') : 'present';
  }
  function section(bundle, key) { return presence(bundle[key], bundle.sectionStates?.[key]); }
  function trackedFixture(fixture, periods, scope) {
    if (!scope?.attentionEligibleCompetitions?.includes(fixture.competitionId)) return false;
    if (!Array.isArray(periods)) return null;
    const when = Date.parse(fixture.kickoffUtc);
    if (!Number.isFinite(when)) return null;
    const teams = [fixture.teams?.home?.id, fixture.teams?.away?.id];
    return periods.some(p => p.tracked === true && p.playerId && teams.includes(p.teamId)
      && scope.trackingLeagues.some(item => item.id === p.competitionId)
      && Number.isFinite(Date.parse(p.from)) && Date.parse(p.from) <= when
      && (!p.to || when < Date.parse(p.to)));
  }
  // Positive event evidence is a lower bound, never a reason to invent zero.
  function goalStatEvidence(row, bundle) {
    if (section(bundle, 'events') !== 'present' || !row?.playerId || !row?.teamId) return null;
    const events = bundle.events || [];
    if (events.some(event => /goal/i.test(event.detail || '') && /cancel|disallow/i.test(event.detail || ''))) return null;
    const count = events.filter(event => event.type === 'goal' && event.teamId === row.teamId
      && event.playerId === row.playerId && ['Normal Goal', 'Penalty'].includes(event.detail)
      && Number.isSafeInteger(event.elapsed) && event.elapsed >= 0 && event.elapsed <= 120
      && !(event.detail === 'Penalty' && bundle.fixture?.status?.short === 'PEN')
      && !/shoot.?out|cancel|disallow/i.test(event.comments || '')).length;
    const value = row.values?.goals;
    return count > 0 && (presence(value, row.fieldStates?.goals) !== 'present' || value < count)
      ? { count, value: presence(value, row.fieldStates?.goals) === 'present' ? value : null } : null;
  }
  // Worker supplies the already decayed, rounded neutral score. Only the local
  // integer percentage is applied here, with exact positive HALF_UP cents.
  function cents(value) {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? ''));
    return match ? BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2,'0')) : null;
  }
  function rankCandidates(candidates, follows) {
    const players = new Set(follows.players), teams = new Set(follows.teams);
    return candidates.flatMap(item => {
      const neutral = cents(item.displayedScore), base = cents(item.baseScore);
      if (neutral === null || base === null || neutral < 1600n) return [];
      const playerBoost = (item.involvedPlayerIds || []).some(id => players.has(id));
      const teamBoost = [item.homeTeamId,item.awayTeamId].some(id => teams.has(id));
      const multiplier = 100 + (playerBoost ? 15 : 0) + (teamBoost ? 10 : 0);
      const personal = (neutral * BigInt(multiplier) + 50n) / 100n;
      return personal < 2000n ? [] : [{ ...item, multiplier: multiplier / 100, personalCents: personal, baseCents: base, personalScore: `${personal / 100n}.${String(personal % 100n).padStart(2,'0')}` }];
    }).sort((a,b) => a.personalCents !== b.personalCents ? (a.personalCents > b.personalCents ? -1 : 1)
      : a.baseCents !== b.baseCents ? (a.baseCents > b.baseCents ? -1 : 1)
      : String(b.kickoffUtc).localeCompare(String(a.kickoffUtc)) || (a.fixtureId < b.fixtureId ? -1 : a.fixtureId > b.fixtureId ? 1 : 0));
  }
  async function loadAttention(fetchPage, season) {
    // Endpoint is gated off until its Phase 1-later DTO is published.
    for (let attempt = 0; attempt < 2; attempt++) {
      let cursor = null, identity = null;
      const candidates = [], seen = new Set(), cursors = new Set();
      try {
        do {
          const page = await fetchPage(season, cursor);
          const binding = [page.asOfUtc,page.candidateRevision,page.attentionVersion,page.scopeVersion];
          if (binding.some(value => !value) || !Array.isArray(page.candidates) || !Object.hasOwn(page,'nextCursor')) throw new Error('invalid_attention_snapshot');
          const nextIdentity = JSON.stringify(binding);
          if (identity !== null && identity !== nextIdentity) throw Object.assign(new Error('attention_cursor_expired'), { status:409,code:'attention_cursor_expired' });
          identity = nextIdentity;
          for (const item of page.candidates) {
            if (!item.fixtureId || seen.has(item.fixtureId) || (item.candidateRevision && item.candidateRevision !== page.candidateRevision)) throw new Error('invalid_attention_snapshot');
            seen.add(item.fixtureId); candidates.push(item);
          }
          cursor = page.nextCursor;
          if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) throw new Error('invalid_attention_cursor');
          cursors.add(cursor);
        } while (cursor !== null);
        return { candidates, ...Object.fromEntries(['asOfUtc','candidateRevision','attentionVersion','scopeVersion'].map((key,i)=>[key,JSON.parse(identity)[i]])) };
      } catch (error) {
        if (attempt === 0 && error.status === 409 && error.code === 'attention_cursor_expired') continue;
        throw error;
      }
    }
  }
  return { normalizeSearchText, searchTokens, matchesSearch, japaneseClubMemberships, presence, section, trackedFixture, goalStatEvidence, rankCandidates, loadAttention };
});
